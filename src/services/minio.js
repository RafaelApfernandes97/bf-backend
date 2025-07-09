const AWS = require('aws-sdk');
const { getFromCache, setCache, generateCacheKey } = require('./cache');
require('dotenv').config();

const s3 = new AWS.S3({
  endpoint: process.env.MINIO_ENDPOINT,
  accessKeyId: process.env.MINIO_ACCESS_KEY,
  secretAccessKey: process.env.MINIO_SECRET_KEY,
  s3ForcePathStyle: true,
  signatureVersion: 'v4',
  region: 'us-east-1',
  maxRetries: 3,
  httpOptions: {
    timeout: 10000, // 10 segundos
    connectTimeout: 5000 // 5 segundos
  }
});

const bucket = process.env.MINIO_BUCKET;

// Gera URL assinada com expiração otimizada
function gerarUrlAssinada(key, expiresIn = 3600) {
  const params = {
    Bucket: bucket,
    Key: key,
    Expires: expiresIn,
  };
  return s3.getSignedUrl('getObject', params);
}

// Lista eventos com cache
async function listarEventos() {
  const cacheKey = generateCacheKey('eventos', 'lista');
  
  // Tenta obter do cache primeiro
  let eventos = await getFromCache(cacheKey);
  
  if (!eventos) {
    try {
      const data = await s3.listObjectsV2({ 
        Bucket: bucket, 
        Delimiter: '/' 
      }).promise();
      
      eventos = (data.CommonPrefixes || []).map(prefix => prefix.Prefix.replace('/', ''));
      
      // Salva no cache por 1 hora
      await setCache(cacheKey, eventos, 3600);
    } catch (error) {
      console.error('Erro ao listar eventos:', error);
      throw error;
    }
  }
  
  return eventos;
}

// Lista coreografias com cache (suporta eventos com dias)
async function listarCoreografias(evento, dia = null) {
  const cacheKey = dia ? 
    generateCacheKey('evento', evento, 'dia', dia, 'coreografias') : 
    generateCacheKey('evento', evento, 'coreografias');
  
  // Tenta obter do cache primeiro
  let coreografias = await getFromCache(cacheKey);
  
  if (!coreografias) {
    try {
      const prefix = dia ? `${evento}/${dia}/` : `${evento}/`;
      const data = await s3.listObjectsV2({
        Bucket: bucket,
        Prefix: prefix,
        Delimiter: '/',
      }).promise();

      coreografias = await Promise.all(
        (data.CommonPrefixes || []).map(async (p) => {
          const nome = p.Prefix.replace(prefix, '').replace('/', '');
          const pastaCoreografia = dia ? `${evento}/${dia}/${nome}/` : `${evento}/${nome}/`;

          // Lista objetos dentro da coreografia
          const objetos = await s3.listObjectsV2({
            Bucket: bucket,
            Prefix: pastaCoreografia,
          }).promise();

          const fotos = objetos.Contents.filter(obj =>
            /\.(jpe?g|png|webp)$/i.test(obj.Key)
          );

          const imagemAleatoria = fotos.length > 0
            ? gerarUrlAssinada(fotos[Math.floor(Math.random() * fotos.length)].Key, 7200) // 2 horas
            : '/img/sem_capa.jpg';

          return {
            nome,
            capa: imagemAleatoria,
            quantidade: fotos.length,
          };
        })
      );

      // Salva no cache por 30 minutos
      await setCache(cacheKey, coreografias, 1800);
    } catch (error) {
      console.error('Erro ao listar coreografias:', error);
      throw error;
    }
  }
  
  return coreografias;
}

// Lista fotos com cache (suporta eventos com dias)
async function listarFotos(evento, coreografia, dia = null) {
  const cacheKey = dia ? 
    generateCacheKey('evento', evento, 'dia', dia, 'coreografia', coreografia, 'fotos') : 
    generateCacheKey('evento', evento, 'coreografia', coreografia, 'fotos');
  
  // Tenta obter do cache primeiro
  let fotos = await getFromCache(cacheKey);
  console.log('[MinIO] listarFotos - Cache key:', cacheKey);
  console.log('[MinIO] listarFotos - Fotos do cache:', fotos ? fotos.length : 'null');
  
  if (!fotos) {
    try {
      const prefix = dia ? `${evento}/${dia}/${coreografia}/` : `${evento}/${coreografia}/`;
      console.log('[MinIO] listarFotos - Prefix:', prefix);
      console.log('[MinIO] listarFotos - Bucket:', bucket);
      
      const data = await s3.listObjectsV2({
        Bucket: bucket,
        Prefix: prefix,
      }).promise();
      
      console.log('[MinIO] listarFotos - Objetos encontrados:', data.Contents?.length || 0);

      // Monta a URL pública (sem assinatura)
      const endpoint = process.env.MINIO_ENDPOINT.replace(/\/$/, '');
      fotos = (data.Contents || [])
        .filter(obj => !obj.Key.endsWith('/'))
        .filter(obj => obj.Key.match(/\.(jpe?g|png|gif|webp)$/i))
        .map(obj => {
          const nomeArquivo = obj.Key.replace(prefix, '');
          const urlPath = dia ? 
            `${encodeURIComponent(evento)}/${encodeURIComponent(dia)}/${encodeURIComponent(coreografia)}/${encodeURIComponent(nomeArquivo)}` :
            `${encodeURIComponent(evento)}/${encodeURIComponent(coreografia)}/${encodeURIComponent(nomeArquivo)}`;
          
          return {
            nome: nomeArquivo,
            url: `${endpoint}/${bucket}/${urlPath}`,
          };
        });

      // Salva no cache por 1 hora (URL pública não expira)
      await setCache(cacheKey, fotos, 3600);
    } catch (error) {
      console.error('Erro ao listar fotos:', error);
      throw error;
    }
  }
  
  return fotos;
}

// Função para pré-carregar dados populares
async function preCarregarDadosPopulares() {
  try {
    console.log('🔄 Iniciando pré-carregamento de dados...');
    
    // Lista eventos
    const eventos = await listarEventos();
    console.log(`✅ Pré-carregados ${eventos.length} eventos`);
    
    // Para cada evento, pré-carrega dados de forma otimizada
    const preloadPromises = eventos.slice(0, 5).map(async (evento) => {
      try {
        console.log(`🔄 Processando evento: ${evento}`);
        
        // Verifica se é um evento multi-dia
        const diasData = await s3.listObjectsV2({
          Bucket: bucket,
          Prefix: `${evento}/`,
          Delimiter: '/',
        }).promise();
        
        const dias = (diasData.CommonPrefixes || [])
          .map(prefix => prefix.Prefix.replace(`${evento}/`, '').replace('/', ''))
          .filter(nome => /^\d{2}-\d{2}-/.test(nome)); // formato DD-MM-dia
        
        if (dias.length > 0) {
          // Evento multi-dia - pré-carrega dados dos dias
          console.log(`📅 Evento ${evento} tem ${dias.length} dias`);
          
          for (const dia of dias.slice(0, 2)) { // Primeiros 2 dias
            try {
              const coreografias = await listarCoreografias(evento, dia);
              console.log(`✅ Pré-carregadas ${coreografias.length} coreografias do dia ${dia}`);
              
              // Pré-carrega fotos das primeiras coreografias
              for (const coreografia of coreografias.slice(0, 3)) {
                try {
                  const fotos = await listarFotosPorCaminho(`${evento}/${dia}/${coreografia.nome}`);
                  console.log(`✅ Pré-carregadas ${fotos.length} fotos: ${evento}/${dia}/${coreografia.nome}`);
                } catch (error) {
                  console.error(`❌ Erro ao pré-carregar fotos ${coreografia.nome}:`, error.message);
                }
              }
            } catch (error) {
              console.error(`❌ Erro ao pré-carregar dia ${dia}:`, error.message);
            }
          }
        } else {
          // Evento de um dia - pré-carrega coreografias diretamente
          const coreografias = await listarCoreografias(evento);
          console.log(`✅ Pré-carregadas ${coreografias.length} coreografias do evento ${evento}`);
          
          // Pré-carrega fotos das primeiras coreografias
          for (const coreografia of coreografias.slice(0, 3)) {
            try {
              const fotos = await listarFotos(evento, coreografia.nome);
              console.log(`✅ Pré-carregadas ${fotos.length} fotos da coreografia ${coreografia.nome}`);
            } catch (error) {
              console.error(`❌ Erro ao pré-carregar fotos ${coreografia.nome}:`, error.message);
            }
          }
        }
      } catch (error) {
        console.error(`❌ Erro ao pré-carregar evento ${evento}:`, error.message);
      }
    });
    
    await Promise.allSettled(preloadPromises);
    console.log('🎉 Pré-carregamento concluído!');
  } catch (error) {
    console.error('❌ Erro no pré-carregamento:', error);
  }
}

// Função otimizada para listar fotos por caminho completo
async function listarFotosPorCaminho(caminho) {
  const cacheKey = generateCacheKey('caminho', caminho, 'fotos');
  
  // Tenta obter do cache primeiro
  let fotos = await getFromCache(cacheKey);
  
  if (!fotos) {
    try {
      const prefix = `${caminho}/`;
      const data = await s3.listObjectsV2({
        Bucket: bucket,
        Prefix: prefix,
      }).promise();

      // Monta a URL pública (sem assinatura)
      const endpoint = process.env.MINIO_ENDPOINT.replace(/\/$/, '');
      fotos = (data.Contents || [])
        .filter(obj => !obj.Key.endsWith('/'))
        .filter(obj => obj.Key.match(/\.(jpe?g|png|gif|webp)$/i))
        .map(obj => {
          const nomeArquivo = obj.Key.replace(prefix, '');
          const urlPath = encodeURIComponent(obj.Key);
          
          return {
            nome: nomeArquivo,
            url: `${endpoint}/${bucket}/${urlPath}`,
          };
        });

      // Salva no cache por 1 hora
      await setCache(cacheKey, fotos, 3600);
    } catch (error) {
      console.error('Erro ao listar fotos por caminho:', error);
      throw error;
    }
  }
  
  return fotos;
}

// Função para aquecer cache de um evento específico
async function aquecerCacheEvento(evento) {
  try {
    console.log(`🔥 Aquecendo cache do evento: ${evento}`);
    
    // Verifica estrutura do evento
    const data = await s3.listObjectsV2({
      Bucket: bucket,
      Prefix: `${evento}/`,
      Delimiter: '/',
    }).promise();
    
    const prefixes = (data.CommonPrefixes || [])
      .map(prefix => prefix.Prefix.replace(`${evento}/`, '').replace('/', ''));
    
    const dias = prefixes.filter(nome => /^\d{2}-\d{2}-/.test(nome));
    
    if (dias.length > 0) {
      // Evento multi-dia
      for (const dia of dias) {
        await listarCoreografias(evento, dia);
      }
    } else {
      // Evento de um dia
      await listarCoreografias(evento);
    }
    
    console.log(`✅ Cache aquecido para evento: ${evento}`);
  } catch (error) {
    console.error(`❌ Erro ao aquecer cache do evento ${evento}:`, error);
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
  preCarregarDadosPopulares,
  aquecerCacheEvento
};
