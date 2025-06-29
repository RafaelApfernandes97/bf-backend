const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Usuario = require('../models/usuario');
const Pedido = require('../models/pedido');
const { sendOrderSummary } = require('../services/evolutionapi');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'segredo123';

function validarEmail(email) {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
}
function validarSenha(senha) {
  return typeof senha === 'string' && senha.length >= 8;
}
function validarCpfCnpj(valor) {
  // Aceita 11 (CPF) ou 14 (CNPJ) dígitos
  return /^\d{11}$/.test(valor) || /^\d{14}$/.test(valor);
}
function validarTelefone(tel) {
  // Aceita 10 ou 11 dígitos
  return /^\d{10,11}$/.test(tel.replace(/\D/g, ''));
}

// Middleware de autenticação JWT
function authMiddleware(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token não fornecido' });
  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.status(401).json({ error: 'Token inválido' });
    req.user = decoded;
    next();
  });
}

// Cadastro de usuário final
router.post('/register', async (req, res) => {
  const { email, senha, nome, cpfCnpj, telefone, cep, rua, numero, bairro, cidade, estado } = req.body;
  if (!email || !senha || !nome) {
    return res.status(400).json({ error: 'Preencha todos os campos obrigatórios.' });
  }
  if (!validarEmail(email)) {
    return res.status(400).json({ error: 'E-mail inválido.' });
  }
  if (!validarSenha(senha)) {
    return res.status(400).json({ error: 'A senha deve ter pelo menos 8 caracteres.' });
  }
  // Validação condicional para CPF/CNPJ e telefone (não obrigatórios para usuários Google)
  if (cpfCnpj && !validarCpfCnpj(cpfCnpj)) {
    return res.status(400).json({ error: 'CPF ou CNPJ inválido.' });
  }
  if (telefone && !validarTelefone(telefone)) {
    return res.status(400).json({ error: 'Telefone/WhatsApp inválido.' });
  }
  const exists = await Usuario.findOne({ email });
  if (exists) return res.status(400).json({ error: 'E-mail já cadastrado.' });
  const hash = await bcrypt.hash(senha, 10);
  const user = await Usuario.create({ email, password: hash, nome, cpfCnpj: cpfCnpj || '', telefone: telefone || '', cep, rua, numero, bairro, cidade, estado });
  res.json({ ok: true });
});

// Login de usuário final
router.post('/login', async (req, res) => {
  const { email, senha } = req.body;
  const user = await Usuario.findOne({ email });
  if (!user) return res.status(401).json({ error: 'E-mail ou senha inválidos.' });
  const ok = await bcrypt.compare(senha, user.password);
  if (!ok) return res.status(401).json({ error: 'E-mail ou senha inválidos.' });
  const token = jwt.sign({ id: user._id, email: user.email, nome: user.nome }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, nome: user.nome });
});

// Rota para obter dados do usuário autenticado
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const user = await Usuario.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
    res.json({
      nome: user.nome,
      email: user.email,
      cpfCnpj: user.cpfCnpj,
      telefone: user.telefone,
      cep: user.cep,
      rua: user.rua,
      numero: user.numero,
      bairro: user.bairro,
      cidade: user.cidade,
      estado: user.estado
    });
  } catch (e) {
    res.status(500).json({ error: 'Erro ao buscar dados do usuário' });
  }
});

// Rota para atualizar dados do usuário autenticado
router.put('/me', authMiddleware, async (req, res) => {
  try {
    const { nome, cpfCnpj, telefone, cep, rua, numero, bairro, cidade, estado } = req.body;
    const user = await Usuario.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
    if (nome) user.nome = nome;
    if (cpfCnpj) user.cpfCnpj = cpfCnpj;
    if (telefone) user.telefone = telefone;
    if (cep) user.cep = cep;
    if (rua) user.rua = rua;
    if (numero) user.numero = numero;
    if (bairro) user.bairro = bairro;
    if (cidade) user.cidade = cidade;
    if (estado) user.estado = estado;
    await user.save();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Erro ao atualizar dados do usuário' });
  }
});

// Rota para enviar resumo do pedido via WhatsApp
router.post('/enviar-pedido-whatsapp', authMiddleware, async (req, res) => {
  console.log('[WhatsApp] Iniciando envio de pedido...');
  try {
    console.log('[WhatsApp] Body recebido:', req.body);
    const { evento, fotos, valorUnitario } = req.body; // fotos: array de objetos com nome, url, coreografia
    console.log('[WhatsApp] Evento:', evento);
    console.log('[WhatsApp] Fotos:', fotos);
    console.log('[WhatsApp] Valor unitário:', valorUnitario);
    console.log('[WhatsApp] User ID:', req.user.id);
    
    const user = await Usuario.findById(req.user.id);
    console.log('[WhatsApp] Usuário encontrado:', user ? 'Sim' : 'Não');
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
    
    console.log('[WhatsApp] Dados do usuário:', {
      nome: user.nome,
      email: user.email,
      telefone: user.telefone,
      cpfCnpj: user.cpfCnpj,
      endereco: `${user.rua}, ${user.numero} - ${user.bairro}, ${user.cidade} - ${user.estado}, CEP: ${user.cep}`
    });
    
    // Gerar ID único do pedido
    const pedidoId = Pedido.gerarPedidoId();
    console.log('[WhatsApp] ID do pedido gerado:', pedidoId);
    
    // Calcular valor total
    const valorTotal = fotos.length * valorUnitario;
    
    // Criar pedido no banco de dados
    const novoPedido = new Pedido({
      pedidoId: pedidoId,
      usuario: user._id,
      evento: evento,
      fotos: fotos,
      valorUnitario: valorUnitario,
      valorTotal: valorTotal,
      status: 'pendente'
    });
    
    await novoPedido.save();
    console.log('[WhatsApp] Pedido salvo no banco de dados');
    
    // Montar mensagem com ID do pedido
    const mensagem = `Resumo do Pedido\n\nID do Pedido: ${pedidoId}\nEvento: ${evento}\n\nNome: ${user.nome}\nEmail: ${user.email}\nTelefone: ${user.telefone}\nCPF: ${user.cpfCnpj}\nEndereço: ${user.rua}, ${user.numero} - ${user.bairro}, ${user.cidade} - ${user.estado}, CEP: ${user.cep}\n\nImagens Selecionadas: ${fotos.length}\nValor Unitário: R$ ${valorUnitario.toFixed(2).replace('.', ',')}\nValor Total: R$ ${valorTotal.toFixed(2).replace('.', ',')}\n\nFotos:\n${fotos.map(f => `- ${f.nome}${f.coreografia ? ` (${f.coreografia})` : ''}`).join('\n')}`;
    console.log('[WhatsApp] Mensagem montada:', mensagem);
    
    const numero = user.telefone; // O serviço evolutionapi.js adiciona o +55 automaticamente
    console.log('[WhatsApp] Número do usuário:', numero);
    
    console.log('[WhatsApp] Chamando sendOrderSummary...');
    await sendOrderSummary({ numero, mensagem });
    console.log('[WhatsApp] sendOrderSummary executado com sucesso');
    
    res.json({ ok: true, pedidoId: pedidoId });
  } catch (e) {
    console.error('[WhatsApp] Erro detalhado:', e);
    console.error('[WhatsApp] Stack trace:', e.stack);
    res.status(500).json({ error: 'Erro ao enviar mensagem WhatsApp: ' + e.message });
  }
});

// Rota para buscar pedidos do usuário
router.get('/meus-pedidos', authMiddleware, async (req, res) => {
  try {
    const pedidos = await Pedido.find({ usuario: req.user.id })
      .sort({ dataCriacao: -1 }) // Mais recentes primeiro
      .limit(20); // Limitar a 20 pedidos
    
    res.json({ pedidos });
  } catch (e) {
    console.error('[Pedidos] Erro ao buscar pedidos:', e);
    res.status(500).json({ error: 'Erro ao buscar pedidos' });
  }
});

// Rota para buscar detalhes de um pedido específico
router.get('/pedido/:pedidoId', authMiddleware, async (req, res) => {
  try {
    const pedido = await Pedido.findOne({ 
      pedidoId: req.params.pedidoId,
      usuario: req.user.id 
    });
    
    if (!pedido) {
      return res.status(404).json({ error: 'Pedido não encontrado' });
    }
    
    res.json({ pedido });
  } catch (e) {
    console.error('[Pedido] Erro ao buscar pedido:', e);
    res.status(500).json({ error: 'Erro ao buscar pedido' });
  }
});

module.exports = router; 