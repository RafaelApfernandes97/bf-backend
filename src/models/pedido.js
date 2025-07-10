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
    enum: ['pendente', 'confirmado', 'cancelado', 'pago', 'entregue'],
    default: 'pendente'
  },
  dataCriacao: {
    type: Date,
    default: Date.now
  },
  dataAtualizacao: {
    type: Date,
    default: Date.now
  },
  logs: [{
    data: {
      type: Date,
      default: Date.now
    },
    acao: {
      type: String,
      enum: ['criado', 'status_alterado', 'valor_alterado', 'item_adicionado', 'item_removido', 'editado'],
      required: true
    },
    descricao: String,
    valorAnterior: mongoose.Schema.Types.Mixed,
    valorNovo: mongoose.Schema.Types.Mixed,
    usuario: String // Nome do admin que fez a alteração
  }],
  itensAdicionais: [{
    descricao: {
      type: String,
      required: true
    },
    valor: {
      type: Number,
      required: true
    },
    dataAdicao: {
      type: Date,
      default: Date.now
    }
  }]
});

// Middleware para atualizar dataAtualizacao
pedidoSchema.pre('save', function(next) {
  this.dataAtualizacao = new Date();
  next();
});

// Substituir a função gerarPedidoId para gerar IDs no formato BEF01, BEF02, ...
pedidoSchema.statics.gerarPedidoId = async function() {
  // Busca o maior pedidoId já existente que comece com 'BEF' e termina com número
  const ultimo = await this.findOne({ pedidoId: /^BEF\d+$/ }).sort({ pedidoId: -1 }).select('pedidoId').lean();
  let proximoNumero = 1;
  if (ultimo && typeof ultimo.pedidoId === 'string') {
    const match = ultimo.pedidoId.match(/^BEF(\d+)$/);
    if (match) {
      proximoNumero = parseInt(match[1], 10) + 1;
    }
  }
  // Garante pelo menos dois dígitos
  const numeroFormatado = proximoNumero < 10 ? '0' + proximoNumero : String(proximoNumero);
  return `BEF${numeroFormatado}`;
};

module.exports = mongoose.model('Pedido', pedidoSchema); 