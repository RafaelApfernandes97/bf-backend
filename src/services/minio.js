const AWS = require('aws-sdk');
const { getFromCache, setCache, generateCacheKey, clearAllCache } = require('./cache');
require('dotenv').config();

const s3 = new AWS.S3({
  region: process.env.AWS_REGION || 'us-east-1',
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  signatureVersion: 'v4',
  maxRetries: 3,
  httpOptions: {
    timeout: 10000, // 10 segundos
    connectTimeout: 5000 // 5 segundos
  }
});

const bucket = process.env.S3_BUCKET;
const bucketPrefix = process.env.S3_BUCKET_PREFIX || 'balletemfoco'; // Prefixo dentro do bucket

// Gera URL assinada com expiração otimizada
function gerarUrlAssinada(key, expiresIn = 3600) {
  // Adiciona o prefixo ao key se não estiver presente
  const fullKey = key.startsWith(bucketPrefix) ? key : `${bucketPrefix}/${key}`;
  
  const params = {
    Bucket: bucket,
    Key: fullKey,
    Expires: expiresIn,
  };
  return s3.getSignedUrl('getObject', params);
}

// Lista eventos SEM cache (sempre busca o estado atual do bucket)
async function listarEventos() {
  try {
    const data = await s3.listObjectsV2({ 
      Bucket: bucket, 
      Prefix: `${bucketPrefix}/`,
      Delimiter: '/' 
    }).promise();
    return (data.CommonPrefixes || [])
      .map(prefix => prefix.Prefix.replace(`${bucketPrefix}/`, '').replace('/', ''));
  } catch (error) {
    console.error('Erro ao listar eventos:', error);
    throw error;
  }
}

// Função recursiva para contar todas as fotos em uma pasta e subpastas, agora com cache
async function contarFotosRecursivo(prefix) {
  const cacheKey = `fotos_count:${prefix}`;
  let total = await getFromCache(cacheKey);
  if (typeof total === 'number') {
    return total;
  }
  total = 0;
  let ContinuationToken = undefined;
  
  // Adiciona o prefixo do bucket se não estiver presente
  const fullPrefix = prefix.startsWith(bucketPrefix) ? prefix : `${bucketPrefix}/${prefix}`;
  
  do {
    const data = await s3.listObjectsV2({
      Bucket: bucket,
      Prefix: fullPrefix,
      ContinuationToken,
    }).promise();
    total += (data.Contents || []).filter(obj =>
      /\.(jpe?g|png|webp)$/i.test(obj.Key)
    ).length;
    const subpastas = (data.CommonPrefixes || []).map(p => p.Prefix);
    for (const subpasta of subpastas) {
      total += await contarFotosRecursivo(subpasta);
    }
    ContinuationToken = data.IsTruncated ? data.NextContinuationToken : undefined;
  } while (ContinuationToken);
  await setCache(cacheKey, total, 1800); // 30 minutos
  return total;
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
      const fullPrefix = `${bucketPrefix}/${prefix}`;
      const data = await s3.listObjectsV2({
        Bucket: bucket,
        Prefix: fullPrefix,
        Delimiter: '/',
      }).promise();

      coreografias = await Promise.all(
        (data.CommonPrefixes || []).map(async (p) => {
          const nome = p.Prefix.replace(fullPrefix, '').replace('/', '');
          const pastaCoreografia = dia ? `${evento}/${dia}/${nome}/` : `${evento}/${nome}/`;
          const fullPastaCoreografia = `${bucketPrefix}/${pastaCoreografia}`;

          // Conta fotos recursivamente
          const quantidade = await contarFotosRecursivo(pastaCoreografia);

          // Lista objetos dentro da coreografia para pegar capa
          const objetos = await s3.listObjectsV2({
            Bucket: bucket,
            Prefix: fullPastaCoreografia,
          }).promise();

          const fotos = objetos.Contents.filter(obj =>
            /\.(jpe?g|png|webp)$/i.test(obj.Key)
          );

          const imagemCapa = fotos.length > 0
            ? gerarUrlAssinada(fotos[0].Key, 7200)
            : '/img/sem_capa.jpg';

          return {
            nome,
            capa: imagemCapa,
            quantidade,
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
  // console.log('[MinIO] listarFotos - Cache key:', cacheKey);
  // console.log('[MinIO] listarFotos - Fotos do cache:', fotos ? fotos.length : 'null');
  
  if (!fotos) {
    try {
      const prefix = dia ? `${evento}/${dia}/${coreografia}/` : `${evento}/${coreografia}/`;
      const fullPrefix = `${bucketPrefix}/${prefix}`;
      // console.log('[MinIO] listarFotos - Prefix:', prefix);
      // console.log('[MinIO] listarFotos - FullPrefix:', fullPrefix);
      // console.log('[MinIO] listarFotos - Bucket:', bucket);
      
      const data = await s3.listObjectsV2({
        Bucket: bucket,
        Prefix: fullPrefix,
      }).promise();
      
      // console.log('[MinIO] listarFotos - Objetos encontrados:', data.Contents?.length || 0);

      // Monta a URL pública (sem assinatura)
      const region = process.env.AWS_REGION || 'us-east-1';
      const endpoint = `https://${bucket}.s3.${region}.amazonaws.com`;
      fotos = (data.Contents || [])
        .filter(obj => !obj.Key.endsWith('/'))
        .filter(obj => obj.Key.match(/\.(jpe?g|png|gif|webp)$/i))
        .map(obj => {
          const nomeArquivo = obj.Key.replace(fullPrefix, '');
          // Codifica cada parte do caminho separadamente para evitar problemas
          const partesPath = obj.Key.split('/');
          const urlPath = partesPath.map(parte => encodeURIComponent(parte)).join('/');
          
          return {
            nome: nomeArquivo,
            url: `${endpoint}/${urlPath}`,
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
    // console.log('🔄 Iniciando varredura completa no MinIO...');
    
    // Limpa todo o cache antes de recarregar
    await clearAllCache();
    // console.log('🧹 Cache limpo, iniciando nova varredura...');
    
    // Lista eventos diretamente do S3 (sem cache)
    // console.log('📂 Varredura de eventos...');
    const data = await s3.listObjectsV2({ 
      Bucket: bucket, 
      Prefix: `${bucketPrefix}/`,
      Delimiter: '/' 
    }).promise();
    
    const eventos = (data.CommonPrefixes || []).map(prefix => prefix.Prefix.replace(`${bucketPrefix}/`, '').replace('/', ''));
    // console.log(`✅ Encontrados ${eventos.length} eventos:`, eventos);
    
    // Para cada evento, faz varredura completa
    const preloadPromises = eventos.map(async (evento) => {
      try {
        // console.log(`🔄 Varredura completa do evento: ${evento}`);
        
        // Verifica se é um evento multi-dia
        const diasData = await s3.listObjectsV2({
          Bucket: bucket,
          Prefix: `${bucketPrefix}/${evento}/`,
          Delimiter: '/',
        }).promise();
        
        const dias = (diasData.CommonPrefixes || [])
          .map(prefix => prefix.Prefix.replace(`${bucketPrefix}/${evento}/`, '').replace('/', ''))
          .filter(nome => /^\d{2}-\d{2}-/.test(nome)); // formato DD-MM-dia
        
        if (dias.length > 0) {
          // Evento multi-dia - varredura completa de todos os dias
          // console.log(`📅 Evento ${evento} tem ${dias.length} dias:`, dias);
          
          for (const dia of dias) {
            try {
              // console.log(`🔄 Varredura do dia: ${evento}/${dia}`);
              
              // Lista coreografias do dia
              const coreografiasData = await s3.listObjectsV2({
                Bucket: bucket,
                Prefix: `${bucketPrefix}/${evento}/${dia}/`,
                Delimiter: '/',
              }).promise();
              
              const coreografias = await Promise.all(
                (coreografiasData.CommonPrefixes || []).map(async (p) => {
                  const nome = p.Prefix.replace(`${bucketPrefix}/${evento}/${dia}/`, '').replace('/', '');
                  const pastaCoreografia = `${evento}/${dia}/${nome}/`;
                  const fullPastaCoreografia = `${bucketPrefix}/${pastaCoreografia}`;
                  
                  // Conta fotos recursivamente
                  const quantidade = await contarFotosRecursivo(pastaCoreografia);
                  
                  // Lista objetos para pegar capa
                  const objetos = await s3.listObjectsV2({
                    Bucket: bucket,
                    Prefix: fullPastaCoreografia,
                  }).promise();
                  
                  const fotos = objetos.Contents.filter(obj =>
                    /\.(jpe?g|png|webp)$/i.test(obj.Key)
                  );
                  
                  const imagemCapa = fotos.length > 0
                    ? gerarUrlAssinada(fotos[0].Key, 7200)
                    : '/img/sem_capa.jpg';
                  
                  return {
                    nome,
                    capa: imagemCapa,
                    quantidade,
                  };
                })
              );
              
              // console.log(`✅ ${coreografias.length} coreografias encontradas no dia ${dia}`);
              
              // Pré-carrega fotos de todas as coreografias
              for (const coreografia of coreografias) {
                try {
                  const fotos = await listarFotosPorCaminho(`${evento}/${dia}/${coreografia.nome}`);
                  // console.log(`✅ ${fotos.length} fotos carregadas: ${evento}/${dia}/${coreografia.nome}`);
                } catch (error) {
                  // console.error(`❌ Erro ao carregar fotos ${coreografia.nome}:`, error.message);
                }
              }
            } catch (error) {
              // console.error(`❌ Erro ao processar dia ${dia}:`, error.message);
            }
          }
        } else {
          // Evento de um dia - varredura completa
          // console.log(`🔄 Varredura de evento simples: ${evento}`);
          
          // Lista coreografias diretamente
          const coreografiasData = await s3.listObjectsV2({
            Bucket: bucket,
            Prefix: `${bucketPrefix}/${evento}/`,
            Delimiter: '/',
          }).promise();
          
          const coreografias = await Promise.all(
            (coreografiasData.CommonPrefixes || []).map(async (p) => {
              const nome = p.Prefix.replace(`${bucketPrefix}/${evento}/`, '').replace('/', '');
              const pastaCoreografia = `${evento}/${nome}/`;
              const fullPastaCoreografia = `${bucketPrefix}/${pastaCoreografia}`;
              
              // Conta fotos recursivamente
              const quantidade = await contarFotosRecursivo(pastaCoreografia);
              
              // Lista objetos para pegar capa
              const objetos = await s3.listObjectsV2({
                Bucket: bucket,
                Prefix: fullPastaCoreografia,
              }).promise();
              
              const fotos = objetos.Contents.filter(obj =>
                /\.(jpe?g|png|webp)$/i.test(obj.Key)
              );
              
              const imagemCapa = fotos.length > 0
                ? gerarUrlAssinada(fotos[0].Key, 7200)
                : '/img/sem_capa.jpg';
              
              return {
                nome,
                capa: imagemCapa,
                quantidade,
              };
            })
          );
          
          // console.log(`✅ ${coreografias.length} coreografias encontradas no evento ${evento}`);
          
          // Pré-carrega fotos de todas as coreografias
          for (const coreografia of coreografias) {
            try {
              const fotos = await listarFotos(evento, coreografia.nome);
              // console.log(`✅ ${fotos.length} fotos carregadas da coreografia ${coreografia.nome}`);
            } catch (error) {
              // console.error(`❌ Erro ao carregar fotos ${coreografia.nome}:`, error.message);
            }
          }
        }
      } catch (error) {
        // console.error(`❌ Erro ao processar evento ${evento}:`, error.message);
      }
    });
    
    await Promise.allSettled(preloadPromises);
    // console.log('🎉 Varredura completa concluída! Todos os dados foram atualizados.');
  } catch (error) {
    // console.error('❌ Erro na varredura completa:', error);
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
      const fullPrefix = `${bucketPrefix}/${prefix}`;
      const data = await s3.listObjectsV2({
        Bucket: bucket,
        Prefix: fullPrefix,
      }).promise();

      // Monta URLs assinadas para garantir acesso correto
      fotos = (data.Contents || [])
        .filter(obj => !obj.Key.endsWith('/'))
        .filter(obj => obj.Key.match(/\.(jpe?g|png|gif|webp)$/i))
        .map(obj => {
          const nomeArquivo = obj.Key.replace(fullPrefix, '');
          // Usar URL assinada para garantir acesso correto
          const urlAssinada = gerarUrlAssinada(obj.Key, 7200); // 2 horas
          
          return {
            nome: nomeArquivo,
            url: urlAssinada,
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
      Prefix: `${bucketPrefix}/${evento}/`,
      Delimiter: '/',
    }).promise();
    
    const prefixes = (data.CommonPrefixes || [])
      .map(prefix => prefix.Prefix.replace(`${bucketPrefix}/${evento}/`, '').replace('/', ''));
    
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

// Função para criar pasta no S3
async function criarPastaNoS3(nomeEvento) {
  try {
    const pastaKey = `${bucketPrefix}/${nomeEvento}/`;
    
    // Criar um arquivo vazio para criar a "pasta"
    await s3.putObject({
      Bucket: bucket,
      Key: pastaKey,
      Body: '',
      ContentType: 'application/x-directory'
    }).promise();
    
    console.log(`Pasta criada no S3: ${pastaKey}`);
    return pastaKey;
  } catch (error) {
    console.error('Erro ao criar pasta no S3:', error);
    throw error;
  }
}

// Função para fazer upload de arquivos otimizada
async function uploadArquivo(arquivo, caminhoDestino) {
  try {
    const key = `${bucketPrefix}/${caminhoDestino}`;
    
    // Upload otimizado com configurações de performance
    const uploadParams = {
      Bucket: bucket,
      Key: key,
      Body: arquivo.buffer,
      ContentType: arquivo.mimetype,
      // Configurações para melhor performance
      StorageClass: 'STANDARD',
      ServerSideEncryption: 'AES256'
    };
    
    // Usar upload gerenciado do AWS SDK para arquivos grandes
    const upload = s3.upload(uploadParams, {
      partSize: 10 * 1024 * 1024, // 10MB por parte
      queueSize: 4, // Máximo 4 partes simultâneas
    });
    
    const result = await upload.promise();
    return result.Key;
    
  } catch (error) {
    console.error('Erro ao fazer upload do arquivo:', error);
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
  preCarregarDadosPopulares,
  aquecerCacheEvento,
  contarFotosRecursivo,
  criarPastaNoS3,
  uploadArquivo
};
