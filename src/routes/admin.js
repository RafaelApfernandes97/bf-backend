const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Evento = require('../models/evento');
const Usuario = require('../models/usuario');
const Pedido = require('../models/pedido');
const { listarEventos } = require('../services/minio');
const TabelaPreco = require('../models/tabelaPreco');
const { clearAllCache } = require('../services/cache');
const { preCarregarDadosPopulares } = require('../services/minio');

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

// ==== MÓDULO FINANCEIRO ====

// Listar todos os pedidos com filtros e paginação
router.get('/pedidos', authMiddleware, async (req, res) => {
  try {
    const { page = 1, limit = 20, status, evento, dataInicio, dataFim, usuario } = req.query;
    const skip = (page - 1) * limit;
    
    // Construir filtros
    const filtros = {};
    if (status) filtros.status = status;
    if (evento) filtros.evento = new RegExp(evento, 'i');
    if (usuario) {
      // Buscar usuários que contenham o nome/email
      const usuarios = await Usuario.find({
        $or: [
          { nome: new RegExp(usuario, 'i') },
          { email: new RegExp(usuario, 'i') }
        ]
      }).select('_id');
      filtros.usuario = { $in: usuarios.map(u => u._id) };
    }
    
    // Filtro de data
    if (dataInicio || dataFim) {
      filtros.dataCriacao = {};
      if (dataInicio) filtros.dataCriacao.$gte = new Date(dataInicio);
      if (dataFim) {
        const dataFimFinal = new Date(dataFim);
        dataFimFinal.setHours(23, 59, 59, 999);
        filtros.dataCriacao.$lte = dataFimFinal;
      }
    }
    
    // Buscar pedidos com população do usuário
    const pedidos = await Pedido.find(filtros)
      .populate('usuario', 'nome email telefone cpfCnpj')
      .sort({ dataCriacao: -1 })
      .skip(skip)
      .limit(parseInt(limit));
    
    // Contar total para paginação
    const total = await Pedido.countDocuments(filtros);
    const totalPages = Math.ceil(total / limit);
    
    res.json({
      pedidos,
      paginacao: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1
      }
    });
  } catch (error) {
    console.error('Erro ao buscar pedidos:', error);
    res.status(500).json({ error: 'Erro ao buscar pedidos' });
  }
});

// Buscar detalhes de um pedido específico
router.get('/pedidos/:id', authMiddleware, async (req, res) => {
  try {
    const pedido = await Pedido.findById(req.params.id)
      .populate('usuario', 'nome email telefone cpfCnpj cep rua numero bairro cidade estado');
    
    if (!pedido) {
      return res.status(404).json({ error: 'Pedido não encontrado' });
    }
    
    res.json(pedido);
  } catch (error) {
    console.error('Erro ao buscar pedido:', error);
    res.status(500).json({ error: 'Erro ao buscar pedido' });
  }
});

// Atualizar status do pedido
router.put('/pedidos/:id/status', authMiddleware, async (req, res) => {
  try {
    const { status } = req.body;
    const statusValidos = ['pendente', 'confirmado', 'cancelado', 'pago', 'entregue'];
    
    if (!statusValidos.includes(status)) {
      return res.status(400).json({ error: 'Status inválido' });
    }
    
    const pedido = await Pedido.findById(req.params.id);
    if (!pedido) {
      return res.status(404).json({ error: 'Pedido não encontrado' });
    }
    
    const statusAnterior = pedido.status;
    
    // Adicionar log da alteração
    pedido.logs.push({
      acao: 'status_alterado',
      descricao: `Status alterado de "${statusAnterior}" para "${status}"`,
      valorAnterior: statusAnterior,
      valorNovo: status,
      usuario: req.user.username || 'Admin'
    });
    
    pedido.status = status;
    pedido.dataAtualizacao = new Date();
    
    await pedido.save();
    await pedido.populate('usuario', 'nome email telefone');
    
    res.json(pedido);
  } catch (error) {
    console.error('Erro ao atualizar status:', error);
    res.status(500).json({ error: 'Erro ao atualizar status' });
  }
});

// Atualizar valor do pedido
router.put('/pedidos/:id/valor', authMiddleware, async (req, res) => {
  try {
    const { valorUnitario } = req.body;
    
    if (!valorUnitario || valorUnitario <= 0) {
      return res.status(400).json({ error: 'Valor unitário inválido' });
    }
    
    const pedido = await Pedido.findById(req.params.id);
    if (!pedido) {
      return res.status(404).json({ error: 'Pedido não encontrado' });
    }
    
    const valorTotal = pedido.fotos.length * valorUnitario;
    
    const pedidoAtualizado = await Pedido.findByIdAndUpdate(
      req.params.id,
      { 
        valorUnitario, 
        valorTotal,
        dataAtualizacao: new Date()
      },
      { new: true }
    ).populate('usuario', 'nome email telefone');
    
    res.json(pedidoAtualizado);
  } catch (error) {
    console.error('Erro ao atualizar valor:', error);
    res.status(500).json({ error: 'Erro ao atualizar valor' });
  }
});

// Adicionar item ao pedido
router.post('/pedidos/:id/itens', authMiddleware, async (req, res) => {
  try {
    const { foto } = req.body; // { nome, url, coreografia }
    
    if (!foto || !foto.nome || !foto.url) {
      return res.status(400).json({ error: 'Dados da foto inválidos' });
    }
    
    const pedido = await Pedido.findById(req.params.id);
    if (!pedido) {
      return res.status(404).json({ error: 'Pedido não encontrado' });
    }
    
    // Verificar se a foto já existe no pedido
    const fotoExiste = pedido.fotos.some(f => f.nome === foto.nome && f.url === foto.url);
    if (fotoExiste) {
      return res.status(400).json({ error: 'Esta foto já está no pedido' });
    }
    
    pedido.fotos.push(foto);
    pedido.valorTotal = pedido.fotos.length * pedido.valorUnitario;
    pedido.dataAtualizacao = new Date();
    
    await pedido.save();
    await pedido.populate('usuario', 'nome email telefone');
    
    res.json(pedido);
  } catch (error) {
    console.error('Erro ao adicionar item:', error);
    res.status(500).json({ error: 'Erro ao adicionar item' });
  }
});

// Remover item do pedido
router.delete('/pedidos/:id/itens/:itemIndex', authMiddleware, async (req, res) => {
  try {
    const { itemIndex } = req.params;
    const index = parseInt(itemIndex);
    
    const pedido = await Pedido.findById(req.params.id);
    if (!pedido) {
      return res.status(404).json({ error: 'Pedido não encontrado' });
    }
    
    if (index < 0 || index >= pedido.fotos.length) {
      return res.status(400).json({ error: 'Índice do item inválido' });
    }
    
    pedido.fotos.splice(index, 1);
    pedido.valorTotal = pedido.fotos.length * pedido.valorUnitario;
    pedido.dataAtualizacao = new Date();
    
    await pedido.save();
    await pedido.populate('usuario', 'nome email telefone');
    
    res.json(pedido);
  } catch (error) {
    console.error('Erro ao remover item:', error);
    res.status(500).json({ error: 'Erro ao remover item' });
  }
});

// Estatísticas do dashboard financeiro
router.get('/estatisticas', authMiddleware, async (req, res) => {
  try {
    const { periodo = '30' } = req.query; // últimos 30 dias por padrão
    const diasAtras = parseInt(periodo);
    const dataInicio = new Date();
    dataInicio.setDate(dataInicio.getDate() - diasAtras);
    
    // Agregações para estatísticas
    const stats = await Pedido.aggregate([
      {
        $facet: {
          // Total de pedidos por status
          porStatus: [
            { $group: { _id: '$status', count: { $sum: 1 }, total: { $sum: '$valorTotal' } } }
          ],
          // Pedidos por período
          porPeriodo: [
            { $match: { dataCriacao: { $gte: dataInicio } } },
            {
              $group: {
                _id: { $dateToString: { format: '%Y-%m-%d', date: '$dataCriacao' } },
                count: { $sum: 1 },
                total: { $sum: '$valorTotal' }
              }
            },
            { $sort: { _id: 1 } }
          ],
          // Pedidos por evento
          porEvento: [
            { $match: { dataCriacao: { $gte: dataInicio } } },
            {
              $group: {
                _id: '$evento',
                count: { $sum: 1 },
                total: { $sum: '$valorTotal' }
              }
            },
            { $sort: { count: -1 } },
            { $limit: 10 }
          ],
          // Totais gerais
          totais: [
            {
              $group: {
                _id: null,
                totalPedidos: { $sum: 1 },
                totalReceita: { $sum: '$valorTotal' },
                receitaPendente: {
                  $sum: { $cond: [{ $eq: ['$status', 'pendente'] }, '$valorTotal', 0] }
                },
                receitaConfirmada: {
                  $sum: { $cond: [{ $eq: ['$status', 'confirmado'] }, '$valorTotal', 0] }
                },
                receitaPaga: {
                  $sum: { $cond: [{ $eq: ['$status', 'pago'] }, '$valorTotal', 0] }
                }
              }
            }
          ],
          // Estatísticas do período
          periodoStats: [
            { $match: { dataCriacao: { $gte: dataInicio } } },
            {
              $group: {
                _id: null,
                pedidosPeriodo: { $sum: 1 },
                receitaPeriodo: { $sum: '$valorTotal' },
                ticketMedio: { $avg: '$valorTotal' }
              }
            }
          ]
        }
      }
    ]);
    
    const resultado = {
      porStatus: stats[0].porStatus,
      porPeriodo: stats[0].porPeriodo,
      porEvento: stats[0].porEvento,
      totais: stats[0].totais[0] || {
        totalPedidos: 0,
        totalReceita: 0,
        receitaPendente: 0,
        receitaConfirmada: 0,
        receitaPaga: 0
      },
      periodo: {
        dias: diasAtras,
        ...(stats[0].periodoStats[0] || {
          pedidosPeriodo: 0,
          receitaPeriodo: 0,
          ticketMedio: 0
        })
      }
    };
    
    res.json(resultado);
  } catch (error) {
    console.error('Erro ao gerar estatísticas:', error);
    res.status(500).json({ error: 'Erro ao gerar estatísticas' });
  }
});

// Relatório de vendas (CSV)
router.get('/relatorio/vendas', authMiddleware, async (req, res) => {
  try {
    const { dataInicio, dataFim, formato = 'json' } = req.query;
    
    const filtros = {};
    if (dataInicio || dataFim) {
      filtros.dataCriacao = {};
      if (dataInicio) filtros.dataCriacao.$gte = new Date(dataInicio);
      if (dataFim) {
        const dataFimFinal = new Date(dataFim);
        dataFimFinal.setHours(23, 59, 59, 999);
        filtros.dataCriacao.$lte = dataFimFinal;
      }
    }
    
    const pedidos = await Pedido.find(filtros)
      .populate('usuario', 'nome email telefone cpfCnpj')
      .sort({ dataCriacao: -1 });
    
    if (formato === 'csv') {
      // Gerar CSV
      const csvHeaders = 'ID,Cliente,Email,Telefone,Evento,Quantidade,Valor Unit,Valor Total,Status,Data\n';
      const csvData = pedidos.map(p => {
        const data = new Date(p.dataCriacao).toLocaleDateString('pt-BR');
        return `${p.pedidoId},"${p.usuario.nome}","${p.usuario.email}","${p.usuario.telefone}","${p.evento}",${p.fotos.length},${p.valorUnitario},${p.valorTotal},"${p.status}","${data}"`;
      }).join('\n');
      
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="relatorio-vendas.csv"');
      res.send(csvHeaders + csvData);
    } else {
      res.json(pedidos);
    }
  } catch (error) {
    console.error('Erro ao gerar relatório:', error);
    res.status(500).json({ error: 'Erro ao gerar relatório' });
  }
});

// Adicionar item adicional ao pedido
router.post('/pedidos/:id/itens-adicionais', authMiddleware, async (req, res) => {
  try {
    const { descricao, valor } = req.body;
    
    if (!descricao || !valor || valor <= 0) {
      return res.status(400).json({ error: 'Descrição e valor são obrigatórios' });
    }
    
    const pedido = await Pedido.findById(req.params.id);
    if (!pedido) {
      return res.status(404).json({ error: 'Pedido não encontrado' });
    }
    
    const novoItem = {
      descricao,
      valor: parseFloat(valor),
      dataAdicao: new Date()
    };
    
    pedido.itensAdicionais.push(novoItem);
    
    // Recalcular valor total
    const valorItensAdicionais = pedido.itensAdicionais.reduce((sum, item) => sum + item.valor, 0);
    const valorFotos = pedido.fotos.length * pedido.valorUnitario;
    pedido.valorTotal = valorFotos + valorItensAdicionais;
    
    // Adicionar log
    pedido.logs.push({
      acao: 'item_adicionado',
      descricao: `Item adicionado: ${descricao} - ${formatCurrency(valor)}`,
      valorNovo: novoItem,
      usuario: req.user.username || 'Admin'
    });
    
    pedido.dataAtualizacao = new Date();
    await pedido.save();
    await pedido.populate('usuario', 'nome email telefone');
    
    res.json(pedido);
  } catch (error) {
    console.error('Erro ao adicionar item:', error);
    res.status(500).json({ error: 'Erro ao adicionar item' });
  }
});

// Remover item adicional do pedido
router.delete('/pedidos/:id/itens-adicionais/:itemId', authMiddleware, async (req, res) => {
  try {
    const pedido = await Pedido.findById(req.params.id);
    if (!pedido) {
      return res.status(404).json({ error: 'Pedido não encontrado' });
    }
    
    const itemIndex = pedido.itensAdicionais.findIndex(item => item._id.toString() === req.params.itemId);
    if (itemIndex === -1) {
      return res.status(404).json({ error: 'Item não encontrado' });
    }
    
    const itemRemovido = pedido.itensAdicionais[itemIndex];
    pedido.itensAdicionais.splice(itemIndex, 1);
    
    // Recalcular valor total
    const valorItensAdicionais = pedido.itensAdicionais.reduce((sum, item) => sum + item.valor, 0);
    const valorFotos = pedido.fotos.length * pedido.valorUnitario;
    pedido.valorTotal = valorFotos + valorItensAdicionais;
    
    // Adicionar log
    pedido.logs.push({
      acao: 'item_removido',
      descricao: `Item removido: ${itemRemovido.descricao} - ${formatCurrency(itemRemovido.valor)}`,
      valorAnterior: itemRemovido,
      usuario: req.user.username || 'Admin'
    });
    
    pedido.dataAtualizacao = new Date();
    await pedido.save();
    await pedido.populate('usuario', 'nome email telefone');
    
    res.json(pedido);
  } catch (error) {
    console.error('Erro ao remover item:', error);
    res.status(500).json({ error: 'Erro ao remover item' });
  }
});

// Função auxiliar para formatar moeda
function formatCurrency(value) {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL'
  }).format(value);
}

// Rota para limpar cache
router.post('/clear-cache', authMiddleware, async (req, res) => {
  try {
    const success = await clearAllCache();
    if (success) {
      res.json({ message: 'Cache limpo com sucesso' });
    } else {
      res.status(500).json({ error: 'Erro ao limpar cache' });
    }
  } catch (error) {
    console.error('Erro ao limpar cache:', error);
    res.status(500).json({ error: 'Erro ao limpar cache' });
  }
});

// Rota para forçar varredura completa no MinIO
router.post('/force-scan', authMiddleware, async (req, res) => {
  try {
    console.log('🔄 Varredura manual solicitada por admin...');
    
    // Executa a varredura em background
    preCarregarDadosPopulares().then(() => {
      console.log('✅ Varredura manual concluída!');
    }).catch((error) => {
      console.error('❌ Erro na varredura manual:', error);
    });
    
    res.json({ 
      message: 'Varredura completa iniciada em background',
      note: 'A varredura pode levar alguns minutos para completar'
    });
  } catch (error) {
    console.error('Erro ao iniciar varredura:', error);
    res.status(500).json({ error: 'Erro ao iniciar varredura' });
  }
});

module.exports = router; 