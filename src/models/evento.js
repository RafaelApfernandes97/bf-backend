const mongoose = require('mongoose');

const EventoSchema = new mongoose.Schema({
  nome: { type: String, required: true },
  data: { type: Date }, // agora opcional
  local: { type: String }, // Local do evento (opcional)
  tabelaPrecoId: { type: mongoose.Schema.Types.ObjectId, ref: 'TabelaPreco' }, // Referência à tabela específica
  valorFixo: { type: Number }, // Se for valor fixo (opcional)
  pastaS3: { type: String }, // Pasta no S3 para o evento
  ativo: { type: Boolean, default: true },
  // Controle de exibição dos banners
  exibirBannerValeCoreografia: { type: Boolean, default: false }, // Banner 1 - Vale Coreografia
  exibirBannerVideo: { type: Boolean, default: false } // Banner 2 - Video
}, { timestamps: true });

module.exports = mongoose.model('Evento', EventoSchema); 