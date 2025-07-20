const AWS = require('aws-sdk');
const { getFromCache, setCache, smartCache, generateCacheKey, clearAllCache } = require('./cache');
require('dotenv').config();

// Pool de conexões otimizado para MinIO
const s3 = new AWS.S3({
  endpoint: process.env.MINIO_ENDPOINT,
  accessKeyId: process.env.MINIO_ACCESS_KEY,
  secretAccessKey: process.env.MINIO_SECRET_KEY,
  s3ForcePathStyle: true,
  signatureVersion: 'v4',
  region: 'us-east-1',
  maxRetries: 5,
  retryDelayOptions: {
    customBackoff: function(retryCount) {
      return Math.pow(2, retryCount) * 100; // backoff exponencial
    }
  },
  httpOptions: {
    timeout: 30000, // 30 segundos
    connectTimeout: 10000, // 10 segundos
    agent: false // Usar agent padrão para pooling
  }
});

const bucket = process.env.MINIO_BUCKET;

// Cache em memória para URLs pré-assinadas (ultra-rápido)
const urlCache = new Map();
const URL_CACHE_TTL = 2 * 60 * 60 * 1000; // 2 horas em ms

// Gera URL assinada otimizada com cache inteligente
function gerarUrlAssinada(key, expiresIn = 7200) {
  const cacheKey = `${key}_${expiresIn}`;
  const cached = urlCache.get(cacheKey);
  
  if (cached && Date.now() < cached.expires) {
    return cached.url;
  }
  
  try {
    const params = {
      Bucket: bucket,
      Key: key,
      Expires: expiresIn,
    };
    const url = s3.getSignedUrl('getObject', params);
    
    // Cache URL com tempo de expiração
    urlCache.set(cacheKey, {
      url,
      expires: Date.now() + (URL_CACHE_TTL)
    });
    
    return url;
  } catch (error) {
    console.error('Erro ao gerar URL assinada:', error);
    // Fallback para URL pública
    const endpoint = process.env.MINIO_ENDPOINT.replace(/\/$/, '');
    return `${endpoint}/${bucket}/${encodeURIComponent(key)}`;
  }
}

// Lista eventos com cache em memória ultra-rápido
async function listarEventos() {
  const cacheKey = 'eventos_lista_rapida';
  
  try {
    // Tenta cache em memória primeiro (sub-segundo)
    let eventos = await getFromCache(cacheKey, true);
    
    if (!eventos) {
      // Se não há cache, busca do MinIO
      const data = await s3.listObjectsV2({ 
        Bucket: bucket, 
        Delimiter: '/',
        MaxKeys: 100 // Limite para performance
      }).promise();
      
      eventos = (data.CommonPrefixes || []).map(prefix => prefix.Prefix.replace('/', ''));
      
             // Cache crítico - eventos são muito acessados
       await smartCache(cacheKey, eventos, 3600, 'critical');
    }
    
    return eventos;
  } catch (error) {
    console.error('Erro ao listar eventos:', error);
    throw error;
  }
}

// Contador de fotos otimizado com cache agressivo
async function contarFotosRecursivo(prefix) {
  const cacheKey = `count_fast:${prefix}`;
  
  // Cache ultra-longo para contadores (6 horas)
  let total = await getFromCache(cacheKey);
  if (typeof total === 'number') {
    return total;
  }
  
  try {
    total = 0;
    let ContinuationToken = undefined;
    
    // Otimização: usar MaxKeys para paginar rapidamente
    do {
      const data = await s3.listObjectsV2({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken,
        MaxKeys: 1000 // Processar em lotes
      }).promise();
      
      total += (data.Contents || []).filter(obj =>
        /\.(jpe?g|png|webp|gif)$/i.test(obj.Key) && !obj.Key.endsWith('/')
      ).length;
      
      ContinuationToken = data.IsTruncated ? data.NextContinuationToken : undefined;
    } while (ContinuationToken);
    
    // Cache por 6 horas (contadores mudam raramente)
    await setCache(cacheKey, total, 21600);
    return total;
  } catch (error) {
    console.error('Erro ao contar fotos:', error);
    return 0; // Retorna 0 em caso de erro
  }
}

// Lista coreografias com cache multi-layer e lazy loading
async function listarCoreografias(evento, dia = null) {
  // Adicionar versão para invalidar cache após correção de capas
  const version = 'v3_capas_corrigidas';
  const cacheKey = dia ? 
    generateCacheKey('coreografias_fast', version, evento, dia) : 
    generateCacheKey('coreografias_fast', version, evento);
  
  try {
    // Cache em memória primeiro
    let coreografias = await getFromCache(cacheKey, true);
    
    if (!coreografias) {
      // Busca do Redis
      coreografias = await getFromCache(cacheKey, false);
      
      if (!coreografias) {
        // Busca do MinIO com otimizações
        const prefix = dia ? `${evento}/${dia}/` : `${evento}/`;
        const data = await s3.listObjectsV2({
          Bucket: bucket,
          Prefix: prefix,
          Delimiter: '/',
          MaxKeys: 50 // Limite para performance
        }).promise();

        // Processamento paralelo otimizado
        coreografias = await Promise.all(
          (data.CommonPrefixes || []).map(async (p) => {
            const nome = p.Prefix.replace(prefix, '').replace('/', '');
            const pastaCoreografia = dia ? `${evento}/${dia}/${nome}/` : `${evento}/${nome}/`;

            // Busca paralela de quantidade e capa
            const [quantidade, primeiraFoto] = await Promise.all([
              contarFotosRecursivo(pastaCoreografia),
              obterPrimeiraFoto(pastaCoreografia)
            ]);

            const imagemCapa = primeiraFoto 
              ? gerarUrlAssinada(primeiraFoto, 14400) // 4 horas
              : '/img/sem_capa.jpg';

            return {
              nome,
              capa: imagemCapa,
              quantidade,
              pastaCoreografia // Adiciona para lazy loading
            };
          })
        );

                 // Cache inteligente para coreografias
         await smartCache(cacheKey, coreografias, 1800, 'frequent');
       } else {
         // Promove do Redis para memória
         await setCache(cacheKey, coreografias, 900, true);
       }
    }
    
    return coreografias;
  } catch (error) {
    console.error('Erro ao listar coreografias:', error);
    throw error;
  }
}

// Função auxiliar para extrair número de um nome de arquivo
function extrairNumero(nome) {
  // Padrão específico: "01 (1).webp", "01 (10).webp", etc.
  // Prioridade 1: Número entre parênteses (mais específico)
  const parenteses = nome.match(/\((\d+)\)/);
  if (parenteses) {
    return parseInt(parenteses[1], 10);
  }
  
  // Prioridade 2: Número após espaço antes da extensão
  const aposEspaco = nome.match(/\s(\d+)(?:\.|$)/);
  if (aposEspaco) {
    return parseInt(aposEspaco[1], 10);
  }
  
  // Prioridade 3: Número no início seguido de underscore ou espaço
  const inicio = nome.match(/^(\d+)[_\s]/);
  if (inicio) {
    return parseInt(inicio[1], 10);
  }
  
  // Prioridade 4: Primeiro número encontrado
  const qualquerNumero = nome.match(/(\d+)/);
  if (qualquerNumero) {
    return parseInt(qualquerNumero[1], 10);
  }
  
  // Se não encontrar número, retornar um valor alto para ficar no final
  return 999999;
}

// Função auxiliar para ordenar fotos por número
function ordenarFotosPorNumero(fotos) {
  const resultado = fotos.sort((a, b) => {
    const nomeA = a.Key || a.nome;
    const nomeB = b.Key || b.nome;
    
    const numA = extrairNumero(nomeA);
    const numB = extrairNumero(nomeB);
    
    // Se os números são diferentes, ordenar por número
    if (numA !== numB) {
      return numA - numB;
    }
    
    // Se os números são iguais, usar ordem alfabética como desempate
    return nomeA.localeCompare(nomeB, 'pt', { numeric: true, sensitivity: 'base' });
  });
  
  // Log resumido para debug
  if (fotos.length > 0) {
    console.log(`[ORDENAÇÃO] Ordenadas ${fotos.length} fotos. Primeiras 3: ${resultado.slice(0, 3).map(f => f.Key || f.nome).join(', ')}`);
  }
  
  return resultado;
}

// Nova função otimizada para obter primeira foto
async function obterPrimeiraFoto(prefix) {
  try {
    console.log(`[PRIMEIRA_FOTO] Buscando primeira foto para: ${prefix}`);
    const data = await s3.listObjectsV2({
      Bucket: bucket,
      Prefix: prefix,
      MaxKeys: 50 // Buscar mais fotos para garantir ordenação correta
    }).promise();
    
    const fotos = (data.Contents || [])
      .filter(obj => !obj.Key.endsWith('/'))
      .filter(obj => /\.(jpe?g|png|webp|gif)$/i.test(obj.Key));
    
    if (fotos.length === 0) {
      console.log(`[PRIMEIRA_FOTO] Nenhuma foto encontrada em: ${prefix}`);
      return null;
    }
    
    // Ordenar fotos e retornar a primeira
    const fotosOrdenadas = ordenarFotosPorNumero(fotos);
    console.log(`[PRIMEIRA_FOTO] Primeira foto ordenada para ${prefix}: ${fotosOrdenadas[0].Key}`);
    return fotosOrdenadas[0].Key;
  } catch (error) {
    console.error('Erro ao obter primeira foto:', error);
    return null;
  }
}

// Lista fotos com paginação e cache otimizado
async function listarFotos(evento, coreografia, dia = null, page = 1, limit = 50) {
  // Adicionar versão para invalidar cache após correção de ordenação
  const version = 'v2_ordenacao_corrigida';
  const cacheKey = dia ? 
    generateCacheKey('fotos_paged', version, evento, dia, coreografia, page, limit) : 
    generateCacheKey('fotos_paged', version, evento, coreografia, page, limit);
  
  try {
    // Cache em memória primeiro
    let resultado = await getFromCache(cacheKey, true);
    
    if (!resultado) {
      // Cache Redis
      resultado = await getFromCache(cacheKey, false);
      
      if (!resultado) {
        // Busca do MinIO com paginação
        const prefix = dia ? `${evento}/${dia}/${coreografia}/` : `${evento}/${coreografia}/`;
        const offset = (page - 1) * limit;
        
        const data = await s3.listObjectsV2({
          Bucket: bucket,
          Prefix: prefix,
          MaxKeys: 1000 // Busca mais para paginar localmente
        }).promise();

        const fotosAOrdenar = (data.Contents || [])
          .filter(obj => !obj.Key.endsWith('/'))
          .filter(obj => /\.(jpe?g|png|webp|gif)$/i.test(obj.Key));
        
        const todasFotos = ordenarFotosPorNumero(fotosAOrdenar);

        const total = todasFotos.length;
        const fotosPagina = todasFotos.slice(offset, offset + limit);
        
        // Gera URLs otimizadas em paralelo
        const endpoint = process.env.MINIO_ENDPOINT.replace(/\/$/, '');
        const fotos = fotosPagina.map(obj => {
          const nomeArquivo = obj.Key.replace(prefix, '');
          const urlPath = obj.Key.split('/').map(parte => encodeURIComponent(parte)).join('/');
          
          return {
            nome: nomeArquivo,
            url: `${endpoint}/${bucket}/${urlPath}`,
            key: obj.Key,
            size: obj.Size,
            lastModified: obj.LastModified
          };
        });

        resultado = {
          fotos,
          pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
            hasNext: page * limit < total,
            hasPrev: page > 1
          }
        };

                 // Cache inteligente baseado no tamanho dos dados
         await smartCache(cacheKey, resultado, 3600, 'auto');
       } else {
         // Promove do Redis para memória se dados pequenos
         const dataSize = JSON.stringify(resultado).length;
         if (dataSize < 10240) { // < 10KB
           await setCache(cacheKey, resultado, 1800, true);
         }
       }
    }
    
    return resultado;
  } catch (error) {
    console.error('Erro ao listar fotos:', error);
    throw error;
  }
}

// Função para pré-carregar dados críticos de forma inteligente
async function preCarregarDadosPopulares() {
  try {
    console.log('🚀 Iniciando pré-carregamento inteligente...');
    
    // 1. Carrega eventos primeiro (crítico)
    console.log('📂 Carregando lista de eventos...');
    const eventos = await listarEventos();
    console.log(`✅ ${eventos.length} eventos carregados`);
    
    // 2. Pré-carrega só os 3 eventos mais recentes (otimização)
    const eventosRecentes = eventos.slice(-3);
    console.log(`🎯 Pré-carregando ${eventosRecentes.length} eventos recentes:`, eventosRecentes);
    
    // 3. Carregamento paralelo otimizado
    await Promise.all(
      eventosRecentes.map(async (evento) => {
        try {
          console.log(`🔄 Pré-carregando: ${evento}`);
          
          // Verifica estrutura do evento
          const estrutura = await analisarEstrutraEvento(evento);
          
          if (estrutura.temDias) {
            // Evento multi-dia: carrega só o primeiro dia
            const primeiroDia = estrutura.dias[0];
            await listarCoreografias(evento, primeiroDia);
            console.log(`✅ Coreografias pré-carregadas: ${evento}/${primeiroDia}`);
          } else {
            // Evento simples: carrega tudo
            await listarCoreografias(evento);
            console.log(`✅ Coreografias pré-carregadas: ${evento}`);
          }
        } catch (error) {
          console.error(`❌ Erro ao pré-carregar ${evento}:`, error.message);
        }
      })
    );
    
    console.log('✅ Pré-carregamento concluído com sucesso!');
    return true;
  } catch (error) {
    console.error('❌ Erro no pré-carregamento:', error);
    return false;
  }
}

// Nova função para analisar estrutura do evento
async function analisarEstrutraEvento(evento) {
  const cacheKey = `estrutura:${evento}`;
  
  try {
    let estrutura = await getFromCache(cacheKey, true);
    
    if (!estrutura) {
      const data = await s3.listObjectsV2({
        Bucket: bucket,
        Prefix: `${evento}/`,
        Delimiter: '/',
        MaxKeys: 20
      }).promise();
      
      const dias = (data.CommonPrefixes || [])
        .map(prefix => prefix.Prefix.replace(`${evento}/`, '').replace('/', ''))
        .filter(nome => /^\d{2}-\d{2}-/.test(nome))
        .sort();
      
      estrutura = {
        temDias: dias.length > 0,
        dias,
        totalPastas: (data.CommonPrefixes || []).length
      };
      
      // Cache por 2 horas (estrutura muda raramente)
      await setCache(cacheKey, estrutura, 7200, true);
    }
    
    return estrutura;
  } catch (error) {
    console.error('Erro ao analisar estrutura:', error);
    return { temDias: false, dias: [], totalPastas: 0 };
  }
}

// Função otimizada para listar fotos por caminho completo (compatibilidade)
async function listarFotosPorCaminho(caminho) {
  // Adicionar versão para invalidar cache após correção de ordenação
  const version = 'v2_ordenacao_corrigida';
  const cacheKey = generateCacheKey('caminho_fotos', version, caminho);
  
  try {
    // Tenta cache primeiro
    let fotos = await getFromCache(cacheKey, true);
    
    if (!fotos) {
      const prefix = `${caminho}/`;
      const data = await s3.listObjectsV2({
        Bucket: bucket,
        Prefix: prefix,
        MaxKeys: 1000 // Limite para performance
      }).promise();
      
      // Filtrar e ordenar fotos
      const fotosAOrdenar = (data.Contents || [])
        .filter(obj => !obj.Key.endsWith('/'))
        .filter(obj => /\.(jpe?g|png|webp|gif)$/i.test(obj.Key));
      
      const fotosOrdenadas = ordenarFotosPorNumero(fotosAOrdenar);
      
      // Gera URLs otimizadas
      const endpoint = process.env.MINIO_ENDPOINT.replace(/\/$/, '');
      fotos = fotosOrdenadas.map(obj => {
        const nomeArquivo = obj.Key.replace(prefix, '');
        const urlPath = obj.Key.split('/').map(parte => encodeURIComponent(parte)).join('/');
        
        return {
          nome: nomeArquivo,
          url: `${endpoint}/${bucket}/${urlPath}`,
          key: obj.Key,
          size: obj.Size,
          lastModified: obj.LastModified
        };
      });

      // Cache inteligente baseado no tamanho
      await smartCache(cacheKey, fotos, 3600, 'auto');
    }
    
    return fotos;
  } catch (error) {
    console.error('Erro ao listar fotos por caminho:', error);
    throw error;
  }
}

module.exports = {
  s3,
  bucket,
  gerarUrlAssinada,
  listarEventos,
  listarCoreografias,
  listarFotos,
  listarFotosPorCaminho,
  contarFotosRecursivo,
  preCarregarDadosPopulares,
  analisarEstrutraEvento,
  obterPrimeiraFoto,
  ordenarFotosPorNumero
};
