const AWS = require('aws-sdk');

// Configuração TURBO para Rekognition com processamento massivo
const isTurboMode = process.env.INDEXACAO_TURBO_MODE === 'true';

AWS.config.update({
  region: process.env.AWS_REGION || 'us-east-1',
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  maxRetries: isTurboMode ? 3 : 5,
  retryDelayOptions: {
    customBackoff: function(retryCount) {
      const baseDelay = isTurboMode ? 100 : 200;
      return Math.pow(2, retryCount) * baseDelay;
    }
  },
  httpOptions: {
    timeout: isTurboMode ? 120000 : 60000, // 2 minutos no modo turbo
    connectTimeout: isTurboMode ? 20000 : 15000,
    maxSockets: isTurboMode ? 200 : 20, // 200 conexões no modo turbo
    agent: false // Desabilita pooling para máxima performance
  }
});

// Aumentar limite de listeners para Rekognition
require('events').EventEmitter.defaultMaxListeners = 1000;

const rekognition = new AWS.Rekognition();

module.exports = {
  async criarColecao(nomeColecao) {
    try {
      await rekognition.createCollection({ CollectionId: nomeColecao }).promise();
      return true;
    } catch (err) {
      if (err.code === 'ResourceAlreadyExistsException') return true;
      throw err;
    }
  },

  async deletarColecao(nomeColecao) {
    try {
      await rekognition.deleteCollection({ CollectionId: nomeColecao }).promise();
      return true;
    } catch (err) {
      throw err;
    }
  },

  async indexarFace(nomeColecao, imagemBuffer, externalImageId) {
    // externalImageId pode ser o nome do arquivo ou ID da foto
    const params = {
      CollectionId: nomeColecao,
      Image: { Bytes: imagemBuffer },
      ExternalImageId: externalImageId,
      DetectionAttributes: [],
    };
    return rekognition.indexFaces(params).promise();
  },

  async buscarFacePorImagem(nomeColecao, imagemBuffer, maxFaces = 5, threshold = 90) {
    const params = {
      CollectionId: nomeColecao,
      Image: { Bytes: imagemBuffer },
      MaxFaces: maxFaces,
      FaceMatchThreshold: threshold,
    };
    return rekognition.searchFacesByImage(params).promise();
  },

  async listarFacesIndexadas(nomeColecao) {
    try {
      const params = {
        CollectionId: nomeColecao,
        MaxResults: 4096 // Máximo permitido pelo AWS
      };
      
      let todasAsFaces = [];
      let nextToken = null;
      
      do {
        if (nextToken) {
          params.NextToken = nextToken;
        }
        
        const result = await rekognition.listFaces(params).promise();
        todasAsFaces = todasAsFaces.concat(result.Faces || []);
        nextToken = result.NextToken;
        
      } while (nextToken);
      
      // Retorna apenas os ExternalImageIds para comparação
      return todasAsFaces.map(face => face.ExternalImageId).filter(id => id);
      
    } catch (err) {
      if (err.code === 'ResourceNotFoundException') {
        return []; // Coleção não existe ainda
      }
      throw err;
    }
  },
}; 