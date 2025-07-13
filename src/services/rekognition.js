const AWS = require('aws-sdk');

// Configuração do AWS SDK (ajustar conforme necessário)
AWS.config.update({
  region: process.env.AWS_REGION || 'us-east-1',
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
});

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