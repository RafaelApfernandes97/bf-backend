const mongoose = require('mongoose');

const UsuarioSchema = new mongoose.Schema({
  // Para admin legacy
  username: { type: String },
  password: { type: String },
  // Para usuário final
  email: { type: String, unique: true, sparse: true },
  nome: { type: String },
  cpfCnpj: { type: String },
  telefone: { type: String },
  cep: { type: String },
  rua: { type: String },
  numero: { type: String },
  complemento: { type: String },
  bairro: { type: String },
  cidade: { type: String },
  estado: { type: String },
  // Para login com Google
  googleId: { type: String, sparse: true },
  isGoogleUser: { type: Boolean, default: false }
}, {
  // Desabilitar validação estrita para permitir campos não definidos no schema
  strict: false,
  // Configurar timestamping automático
  timestamps: true
});

// Virtual para endereço completo
UsuarioSchema.virtual('endereco').get(function() {
  const parts = [];
  if (this.rua) parts.push(this.rua);
  if (this.numero) parts.push(this.numero);
  if (this.complemento) parts.push(this.complemento);
  if (this.bairro) parts.push(this.bairro);
  return parts.join(', ') || '';
});

// Ensure virtual fields are serialised
UsuarioSchema.set('toJSON', { virtuals: true });
UsuarioSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Usuario', UsuarioSchema); 