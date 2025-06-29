const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Evento = require('../models/evento');
const Usuario = require('../models/usuario');
const { listarEventos } = require('../services/minio');
const TabelaPreco = require('../models/tabelaPreco');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'segredo123';

// Middleware para proteger rotas
function authMiddleware(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token não fornecido' });
  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.status(401).json({ error: 'Token inválido' });
    req.user = decoded;
    next();
  });
}

// Cadastro de admin (apenas para setup inicial, depois pode remover)
router.post('/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Usuário e senha obrigatórios' });
  const hash = await bcrypt.hash(password, 10);
  try {
    const user = await Usuario.create({ username, password: hash });
    res.json({ user: user.username });
  } catch (e) {
    res.status(400).json({ error: 'Usuário já existe' });
  }
});

// Login
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const user = await Usuario.findOne({ username });
  if (!user) return res.status(401).json({ error: 'Usuário ou senha inválidos' });
  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.status(401).json({ error: 'Usuário ou senha inválidos' });
  const token = jwt.sign({ id: user._id, username: user.username }, JWT_SECRET, { expiresIn: '2h' });
  res.json({ token });
});

// CRUD de tabelas de preço
router.get('/tabelas-preco', async (req, res) => {
  const tabelas = await TabelaPreco.find().sort({ nome: 1 });
  res.json(tabelas);
});

router.post('/tabelas-preco', authMiddleware, async (req, res) => {
  const { nome, descricao, faixas, isDefault } = req.body;
  const tabela = await TabelaPreco.create({ nome, descricao, faixas, isDefault });
  res.json(tabela);
});

router.put('/tabelas-preco/:id', authMiddleware, async (req, res) => {
  const { nome, descricao, faixas, isDefault } = req.body;
  const tabela = await TabelaPreco.findByIdAndUpdate(req.params.id, { nome, descricao, faixas, isDefault }, { new: true });
  res.json(tabela);
});

router.delete('/tabelas-preco/:id', authMiddleware, async (req, res) => {
  await TabelaPreco.findByIdAndDelete(req.params.id);
  res.json({ ok: true });
});

// Atualizar rotas de eventos para usar tabela de preço
router.get('/eventos', async (req, res) => {
  const eventos = await Evento.find().populate('tabelaPrecoId');
  res.json(eventos);
});

router.post('/eventos', authMiddleware, async (req, res) => {
  const { nome, data, local, tabelaPrecoId, valorFixo } = req.body;
  const evento = await Evento.create({ nome, data, local, tabelaPrecoId, valorFixo });
  await evento.populate('tabelaPrecoId');
  res.json(evento);
});

router.put('/eventos/:id', authMiddleware, async (req, res) => {
  const { nome, data, local, tabelaPrecoId, valorFixo } = req.body;
  const evento = await Evento.findByIdAndUpdate(req.params.id, { nome, data, local, tabelaPrecoId, valorFixo }, { new: true });
  await evento.populate('tabelaPrecoId');
  res.json(evento);
});

router.delete('/eventos/:id', authMiddleware, async (req, res) => {
  await Evento.findByIdAndDelete(req.params.id);
  res.json({ ok: true });
});

// Lista eventos do MinIO (para preenchimento no admin)
router.get('/eventos-minio', authMiddleware, async (req, res) => {
  try {
    const eventos = await listarEventos();
    res.json(eventos);
  } catch (e) {
    res.status(500).json({ error: 'Erro ao listar eventos do MinIO' });
  }
});

// Função utilitária para calcular preço baseado na quantidade
function calcularPrecoPorQuantidade(tabelaPreco, quantidade) {
  if (!tabelaPreco || !tabelaPreco.faixas) return null;
  
  // Ordena as faixas por valor mínimo (crescente)
  const faixasOrdenadas = [...tabelaPreco.faixas].sort((a, b) => a.min - b.min);
  
  // Encontra a faixa que se aplica à quantidade
  for (const faixa of faixasOrdenadas) {
    const min = faixa.min;
    const max = faixa.max;
    
    // Se não tem max, aceita qualquer valor >= min
    if (!max) {
      if (quantidade >= min) {
        return faixa.valor;
      }
    } else {
      // Se tem max, verifica se está no intervalo
      if (quantidade >= min && quantidade <= max) {
        return faixa.valor;
      }
    }
  }
  
  return null; // Nenhuma faixa se aplica
}

// Rota para calcular preço (para uso futuro)
router.post('/calcular-preco', authMiddleware, async (req, res) => {
  const { eventoId, quantidade } = req.body;
  
  try {
    const evento = await Evento.findById(eventoId).populate('tabelaPrecoId');
    if (!evento) {
      return res.status(404).json({ error: 'Evento não encontrado' });
    }
    
    // Se evento tem valor fixo, retorna ele
    if (evento.valorFixo) {
      return res.json({ valor: evento.valorFixo });
    }
    
    // Se evento tem tabela específica, usa ela
    if (evento.tabelaPrecoId) {
      const valor = calcularPrecoPorQuantidade(evento.tabelaPrecoId, quantidade);
      if (valor !== null) {
        return res.json({ valor });
      }
    }
    
    // Se não tem tabela específica, busca a tabela default
    const tabelaDefault = await TabelaPreco.findOne({ isDefault: true });
    if (tabelaDefault) {
      const valor = calcularPrecoPorQuantidade(tabelaDefault, quantidade);
      if (valor !== null) {
        return res.json({ valor });
      }
    }
    
    res.status(404).json({ error: 'Nenhuma tabela de preço aplicável encontrada' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao calcular preço' });
  }
});

module.exports = router; 