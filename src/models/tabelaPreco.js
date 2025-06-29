const mongoose = require('mongoose');

const FaixaPrecoSchema = new mongoose.Schema({
  min: { type: Number, required: true },
  max: { type: Number, required: false },
  valor: { type: Number, required: true }
}, { _id: false });

const TabelaPrecoSchema = new mongoose.Schema({
  nome: { type: String, required: true, unique: true },
  descricao: { type: String },
  faixas: [FaixaPrecoSchema],
  isDefault: { type: Boolean, default: false },
  ativo: { type: Boolean, default: true }
}, { timestamps: true });

// Middleware para garantir que apenas uma tabela seja default
TabelaPrecoSchema.pre('save', async function(next) {
  if (this.isDefault) {
    await this.constructor.updateMany(
      { _id: { $ne: this._id } },
      { isDefault: false }
    );
  }
  next();
});

module.exports = mongoose.model('TabelaPreco', TabelaPrecoSchema); 