const mongoose = require('mongoose');

const CupomSchema = new mongoose.Schema({
  codigo: { 
    type: String, 
    required: true, 
    unique: true,
    uppercase: true,
    trim: true
  },
  descricao: { 
    type: String, 
    required: true 
  },
  tipoDesconto: { 
    type: String, 
    enum: ['valor', 'porcentagem'], 
    required: true 
  },
  valorDesconto: { 
    type: Number, 
    required: true,
    min: 0
  },
  quantidadeTotal: { 
    type: Number, 
    required: true,
    min: 1
  },
  quantidadeUsada: { 
    type: Number, 
    default: 0,
    min: 0
  },
  limitarPorUsuario: { 
    type: Boolean, 
    default: false 
  },
  dataExpiracao: { 
    type: Date 
  },
  ativo: { 
    type: Boolean, 
    default: true 
  },
  // Array para controlar uso por usuário
  usuariosQueUsaram: [{
    usuarioId: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario' },
    dataUso: { type: Date, default: Date.now },
    pedidoId: { type: mongoose.Schema.Types.ObjectId, ref: 'Pedido' }
  }]
}, { timestamps: true });

// Middleware para converter código para maiúsculo
CupomSchema.pre('save', function(next) {
  if (this.codigo) {
    this.codigo = this.codigo.toUpperCase();
  }
  next();
});

// Método para verificar se cupom está válido
CupomSchema.methods.isValido = function() {
  if (!this.ativo) return { valido: false, motivo: 'Cupom desativado' };
  
  if (this.quantidadeUsada >= this.quantidadeTotal) {
    return { valido: false, motivo: 'Cupom esgotado' };
  }
  
  if (this.dataExpiracao && new Date() > this.dataExpiracao) {
    return { valido: false, motivo: 'Cupom expirado' };
  }
  
  return { valido: true };
};

// Método para verificar se usuário já usou o cupom
CupomSchema.methods.usuarioJaUsou = function(usuarioId) {
  if (!this.limitarPorUsuario) return false;
  
  return this.usuariosQueUsaram.some(uso => 
    uso.usuarioId && uso.usuarioId.toString() === usuarioId.toString()
  );
};

// Método para calcular desconto
CupomSchema.methods.calcularDesconto = function(valorTotal) {
  if (this.tipoDesconto === 'porcentagem') {
    const desconto = (valorTotal * this.valorDesconto) / 100;
    // Limitar desconto máximo de 100%
    return Math.min(desconto, valorTotal);
  } else {
    // Valor fixo, mas não pode ser maior que o total
    return Math.min(this.valorDesconto, valorTotal);
  }
};

// Método para usar o cupom (registrar uso)
CupomSchema.methods.usarCupom = function(usuarioId, pedidoId = null) {
  // Verificar se é válido antes de usar
  const validacao = this.isValido();
  if (!validacao.valido) {
    throw new Error(validacao.motivo);
  }
  
  // Verificar se usuário já usou (se aplicável)
  if (this.limitarPorUsuario && usuarioId && this.usuarioJaUsou(usuarioId)) {
    throw new Error('Este cupom já foi utilizado por você. Cada usuário pode usar este cupom apenas uma vez.');
  }
  
  // Incrementar quantidade usada
  this.quantidadeUsada += 1;
  
  // Adicionar usuário à lista (se aplicável)
  if (this.limitarPorUsuario && usuarioId) {
    this.usuariosQueUsaram.push({
      usuarioId: usuarioId,
      dataUso: new Date(),
      pedidoId: pedidoId
    });
  }
  
  return this.save();
};

module.exports = mongoose.model('Cupom', CupomSchema); 