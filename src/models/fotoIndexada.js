const mongoose = require('mongoose');

const fotoIndexadaSchema = new mongoose.Schema({
  evento: { 
    type: String, 
    required: true,
    index: true 
  },
  nomeArquivo: { 
    type: String, 
    required: true 
  },
  nomeArquivoNormalizado: { 
    type: String, 
    required: true,
    index: true 
  },
  caminhoCompleto: { 
    type: String, 
    required: true 
  },
  s3Key: { 
    type: String, 
    required: true 
  },
  colecaoRekognition: { 
    type: String, 
    required: true 
  },
  faceId: { 
    type: String // ID da face retornado pelo Rekognition
  },
  status: { 
    type: String, 
    enum: ['indexada', 'erro', 'processando'],
    default: 'indexada'
  },
  erroDetalhes: { 
    type: String // Detalhes do erro se status for 'erro'
  },
  indexadaEm: { 
    type: Date, 
    default: Date.now 
  },
  tamanhoArquivo: { 
    type: Number // Tamanho em bytes
  },
  dimensoes: {
    largura: Number,
    altura: Number
  }
}, {
  timestamps: true
});

// Índices compostos para consultas eficientes
fotoIndexadaSchema.index({ evento: 1, nomeArquivoNormalizado: 1 }, { unique: true });
fotoIndexadaSchema.index({ evento: 1, status: 1 });
fotoIndexadaSchema.index({ colecaoRekognition: 1 });

// Método estático para verificar se uma foto já foi indexada
fotoIndexadaSchema.statics.jaIndexada = async function(evento, nomeArquivoNormalizado) {
  const foto = await this.findOne({ 
    evento, 
    nomeArquivoNormalizado, 
    status: 'indexada' 
  });
  return !!foto;
};

// Método estático para obter estatísticas de indexação de um evento
fotoIndexadaSchema.statics.estatisticasEvento = async function(evento) {
  console.log(`[DEBUG] Executando query de estatísticas para evento: ${evento}`);
  
  // Primeiro, verificar se existem registros para este evento
  const totalRegistros = await this.countDocuments({ evento });
  console.log(`[DEBUG] Total de registros encontrados para evento ${evento}: ${totalRegistros}`);
  
  const resultado = await this.aggregate([
    { $match: { evento } },
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 }
      }
    }
  ]);
  
  console.log(`[DEBUG] Resultado da agregação:`, resultado);
  
  const stats = {
    indexadas: 0,
    erros: 0,
    processando: 0,
    total: 0
  };
  
  resultado.forEach(item => {
    stats[item._id] = item.count;
    stats.total += item.count;
  });
  
  console.log(`[DEBUG] Estatísticas finais:`, stats);
  
  return stats;
};

// Método estático para marcar foto como indexada
fotoIndexadaSchema.statics.marcarComoIndexada = async function(dadosFoto) {
  console.log(`[DEBUG] Tentando salvar foto no banco - Evento: ${dadosFoto.evento}, Nome: ${dadosFoto.nomeArquivoNormalizado}`);
  
  const resultado = await this.findOneAndUpdate(
    { 
      evento: dadosFoto.evento, 
      nomeArquivoNormalizado: dadosFoto.nomeArquivoNormalizado 
    },
    {
      ...dadosFoto,
      status: 'indexada',
      indexadaEm: new Date()
    },
    { 
      upsert: true, 
      new: true 
    }
  );
  
  console.log(`[DEBUG] Foto salva no banco com sucesso - ID: ${resultado._id}, Status: ${resultado.status}`);
  
  return resultado;
};

// Método estático para marcar foto com erro
fotoIndexadaSchema.statics.marcarComErro = async function(evento, nomeArquivoNormalizado, erroDetalhes) {
  return this.findOneAndUpdate(
    { evento, nomeArquivoNormalizado },
    {
      status: 'erro',
      erroDetalhes,
      indexadaEm: new Date()
    },
    { 
      upsert: true, 
      new: true 
    }
  );
};

// Método estático para listar fotos indexadas de um evento
fotoIndexadaSchema.statics.listarPorEvento = async function(evento, status = 'indexada') {
  return this.find({ evento, status })
    .sort({ indexadaEm: -1 });
};

// Método estático para limpar registros de fotos que não existem mais no S3
fotoIndexadaSchema.statics.limparFotosInexistentes = async function(evento, fotosExistentesS3) {
  const fotosRegistradas = await this.find({ evento }, 'nomeArquivoNormalizado');
  const nomesExistentes = fotosExistentesS3.map(foto => foto.nomeArquivoNormalizado);
  
  const fotosParaRemover = fotosRegistradas.filter(
    foto => !nomesExistentes.includes(foto.nomeArquivoNormalizado)
  );
  
  if (fotosParaRemover.length > 0) {
    await this.deleteMany({
      evento,
      nomeArquivoNormalizado: { $in: fotosParaRemover.map(f => f.nomeArquivoNormalizado) }
    });
    console.log(`[INFO] Removidos ${fotosParaRemover.length} registros de fotos que não existem mais no S3`);
  }
  
  return fotosParaRemover.length;
};

module.exports = mongoose.model('FotoIndexada', fotoIndexadaSchema);