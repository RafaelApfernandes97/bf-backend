const mongoose = require('mongoose');

const EventoSchema = new mongoose.Schema({
  nome: { type: String, required: true },
  data: { type: Date }, // agora opcional
  tabelaPrecoId: { type: mongoose.Schema.Types.ObjectId, ref: 'TabelaPreco' }, // Referência à tabela específica
  valorFixo: { type: Number }, // Se for valor fixo (opcional)
  pastaS3: { type: String }, // Pasta no S3 para o evento
  ativo: { type: Boolean, default: true }
}, { timestamps: true });

module.exports = mongoose.model('Evento', EventoSchema); 