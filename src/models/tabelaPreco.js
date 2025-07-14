const mongoose = require('mongoose');

const tabelaPrecoSchema = new mongoose.Schema({
  nome: { type: String, required: true },
  descricao: { type: String },
  faixas: [{
    min: { type: Number, required: true },
    max: { type: Number }, // Se null, é aberto (ex: 50+)
    valor: { type: Number, required: true }
  }],
  // Preços específicos para produtos de banner
  precoValeCoreografia: { type: Number, default: 0 }, // Preço do Vale Coreografia
  precoVideo: { type: Number, default: 0 }, // Preço do Vídeo
  isDefault: { type: Boolean, default: false }
}, { timestamps: true });

module.exports = mongoose.model('TabelaPreco', tabelaPrecoSchema); 