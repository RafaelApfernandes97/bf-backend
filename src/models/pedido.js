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
    coreografia: String,
    codigo: String // Código da imagem para banners (vale/vídeo/poster)
  }],
  valorUnitario: {
    type: Number,
    required: true
  },
  valorTotal: {
    type: Number,
    required: true
  },
  // Campos do cupom de desconto
  cupom: {
    codigo: String,
    descricao: String,
    desconto: Number, // Valor do desconto aplicado
    cupomId: { type: mongoose.Schema.Types.ObjectId, ref: 'Cupom' }
  },
  status: {
    type: String,
    enum: ['pendente', 'pago', 'preparando_pedido', 'enviado', 'cancelado'],
    default: 'pendente'
  },
  // Campos de nota fiscal
  numeroNotaFiscal: {
    type: String,
    default: ''
  },
  periodoNotaFiscal: {
    type: String,
    default: ''
  },
  statusNotaFiscal: {
    type: String,
    enum: ['pendente', 'cpf_invalido', 'cpf_validado', 'concluido'],
    default: 'pendente'
  },
  // Campos de desconto
  desconto: {
    tipo: {
      type: String,
      enum: ['valor', 'percentual']
    },
    valor: Number
  },
  valorDesconto: {
    type: Number,
    default: 0
  },
  valorEditadoManualmente: {
    type: Boolean,
    default: false
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
      enum: [
        'criado', 'status_alterado', 'valor_alterado', 'item_adicionado', 'item_removido', 'editado',
        'mensagem_enviada', 'nota_fiscal_atualizada', 'status_nota_fiscal_atualizado', 
        'dados_usuario_editados', 'desconto_aplicado', 'valor_final_editado'
      ],
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
  // Busca todos os pedidoId existentes no formato BEF\d+
  const pedidos = await this.find({ pedidoId: /^BEF\d+$/ }).select('pedidoId').lean();
  // Extrai os números dos IDs
  const numeros = pedidos
    .map(p => {
      const match = p.pedidoId.match(/^BEF(\d+)$/);
      return match ? parseInt(match[1], 10) : null;
    })
    .filter(n => n !== null)
    .sort((a, b) => a - b);
  // Encontra o menor número disponível na sequência
  let proximoNumero = 1;
  for (let i = 0; i < numeros.length; i++) {
    if (numeros[i] !== i + 1) {
      proximoNumero = i + 1;
      break;
    }
    // Se chegou ao fim sem buracos, o próximo é o maior + 1
    if (i === numeros.length - 1) {
      proximoNumero = numeros.length + 1;
    }
  }
  // Garante pelo menos dois dígitos
  const numeroFormatado = proximoNumero < 10 ? '0' + proximoNumero : String(proximoNumero);
  return `BEF${numeroFormatado}`;
};

module.exports = mongoose.model('Pedido', pedidoSchema); 