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

// Lista coreografias com cache
async function listarCoreografias(evento) {
  const cacheKey = generateCacheKey('evento', evento, 'coreografias');
  
  // Tenta obter do cache primeiro
  let coreografias = await getFromCache(cacheKey);
  
  if (!coreografias) {
    try {
      const prefix = `${evento}/`;
      const data = await s3.listObjectsV2({
        Bucket: bucket,
        Prefix: prefix,
        Delimiter: '/',
      }).promise();

      coreografias = await Promise.all(
        (data.CommonPrefixes || []).map(async (p) => {
          const nome = p.Prefix.replace(prefix, '').replace('/', '');
          const pastaCoreografia = `${evento}/${nome}/`;

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

// Lista fotos com cache
async function listarFotos(evento, coreografia) {
  const cacheKey = generateCacheKey('evento', evento, 'coreografia', coreografia, 'fotos');
  
  // Tenta obter do cache primeiro
  let fotos = await getFromCache(cacheKey);
  
  if (!fotos) {
    try {
      const prefix = `${evento}/${coreografia}/`;
      const data = await s3.listObjectsV2({
        Bucket: bucket,
        Prefix: prefix,
      }).promise();

      fotos = (data.Contents || [])
        .filter(obj => !obj.Key.endsWith('/'))
        .filter(obj => obj.Key.match(/\.(jpe?g|png|gif|webp)$/i))
        .map(obj => ({
          nome: obj.Key.replace(prefix, ''),
          url: gerarUrlAssinada(obj.Key, 3600), // 1 hora
        }));

      // Salva no cache por 15 minutos (URLs assinadas expiram em 1h)
      await setCache(cacheKey, fotos, 900);
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
    console.log('Iniciando pré-carregamento de dados...');
    
    // Lista eventos
    const eventos = await listarEventos();
    console.log(`Pré-carregados ${eventos.length} eventos`);
    
    // Para cada evento, pré-carrega algumas coreografias
    for (const evento of eventos.slice(0, 3)) { // Primeiros 3 eventos
      try {
        const coreografias = await listarCoreografias(evento);
        console.log(`Pré-carregadas ${coreografias.length} coreografias do evento ${evento}`);
        
        // Pré-carrega fotos das primeiras coreografias
        for (const coreografia of coreografias.slice(0, 2)) {
          try {
            const fotos = await listarFotos(evento, coreografia.nome);
            console.log(`Pré-carregadas ${fotos.length} fotos da coreografia ${coreografia.nome}`);
          } catch (error) {
            console.error(`Erro ao pré-carregar fotos de ${coreografia.nome}:`, error);
          }
        }
      } catch (error) {
        console.error(`Erro ao pré-carregar coreografias de ${evento}:`, error);
      }
    }
    
    console.log('Pré-carregamento concluído!');
  } catch (error) {
    console.error('Erro no pré-carregamento:', error);
  }
}

module.exports = { 
  s3, 
  bucket, 
  gerarUrlAssinada,
  listarEventos,
  listarCoreografias,
  listarFotos,
  preCarregarDadosPopulares
};
