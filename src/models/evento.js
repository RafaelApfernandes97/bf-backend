const mongoose = require('mongoose');

const EventoSchema = new mongoose.Schema({
  nome: { type: String, required: true },
  data: { type: Date }, // agora opcional
  tabelaPrecoId: { type: mongoose.Schema.Types.ObjectId, ref: 'TabelaPreco' }, // Referência à tabela específica
  valorFixo: { type: Number }, // Se for valor fixo (opcional)
  ativo: { type: Boolean, default: true },
  // Configurações dos banners
  bannerVale: { type: Boolean, default: false },
  bannerVideo: { type: Boolean, default: false },
  bannerPoster: { type: Boolean, default: false },
  valorVale: { type: Number, default: 0 },
  valorVideo: { type: Number, default: 0 },
  valorPoster: { type: Number, default: 0 }
}, { timestamps: true });

module.exports = mongoose.model('Evento', EventoSchema); 