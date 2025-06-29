const mongoose = require('mongoose');

const EventoSchema = new mongoose.Schema({
  nome: { type: String, required: true },
  data: { type: Date, required: true },
  local: { type: String, required: true },
  tabelaPrecoId: { type: mongoose.Schema.Types.ObjectId, ref: 'TabelaPreco' }, // Referência à tabela específica
  valorFixo: { type: Number }, // Se for valor fixo (opcional)
  ativo: { type: Boolean, default: true }
}, { timestamps: true });

module.exports = mongoose.model('Evento', EventoSchema); 