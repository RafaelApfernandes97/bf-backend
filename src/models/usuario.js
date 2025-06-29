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
  bairro: { type: String },
  cidade: { type: String },
  estado: { type: String },
  // Para login com Google
  googleId: { type: String, sparse: true },
  isGoogleUser: { type: Boolean, default: false }
});

module.exports = mongoose.model('Usuario', UsuarioSchema); 