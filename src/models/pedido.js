const mongoose = require('mongoose');

const pedidoSchema = new mongoose.Schema({
  pedidoId: {
    type: String,
    required: true,
    unique: true
  },
  usuario: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Usuario',
    required: true
  },
  evento: {
    type: String,
    required: true
  },
  fotos: [{
    nome: String,
    url: String,
    coreografia: String
  }],
  valorUnitario: {
    type: Number,
    required: true
  },
  valorTotal: {
    type: Number,
    required: true
  },
  status: {
    type: String,
    enum: ['pendente', 'confirmado', 'cancelado'],
    default: 'pendente'
  },
  dataCriacao: {
    type: Date,
    default: Date.now
  },
  dataAtualizacao: {
    type: Date,
    default: Date.now
  }
});

// Middleware para atualizar dataAtualizacao
pedidoSchema.pre('save', function(next) {
  this.dataAtualizacao = new Date();
  next();
});

// Método para gerar ID único do pedido
pedidoSchema.statics.gerarPedidoId = function() {
  // Gera um ID numérico curto (ex: 7 dígitos)
  const ts = Date.now().toString().slice(-5); // últimos 5 dígitos do timestamp
  const rand = Math.floor(100 + Math.random() * 900); // 3 dígitos aleatórios
  return ts + rand; // Exemplo: 1234567
};

module.exports = mongoose.model('Pedido', pedidoSchema); 