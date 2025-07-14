const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Evento = require('../models/evento');
const Usuario = require('../models/usuario');
const Pedido = require('../models/pedido');
const FotoIndexada = require('../models/fotoIndexada');
const { listarEventos, criarPastaNoS3, invalidarCacheEvento } = require('../services/minio');
const TabelaPreco = require('../models/tabelaPreco');
const { clearAllCache } = require('../services/cache');
const { preCarregarDadosPopulares } = require('../services/minio');
const minioService = require('../services/minio');
const rekognitionService = require('../services/rekognition');
const path = require('path');
const sharp = require('sharp');

// Import bucket prefix from environment
const bucketPrefix = process.env.S3_BUCKET_PREFIX || 'balletemfoco';

// Armazenamento em memória para progresso de indexação
const progressoIndexacao = new Map();

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'segredo123';

// Middleware para proteger rotas
function authMiddleware(req, res, next) {
  console.log(`[DEBUG] AuthMiddleware - Rota: ${req.method} ${req.path}`);
  const token = req.headers['authorization']?.split(' ')[1];
  console.log(`[DEBUG] AuthMiddleware - Token presente: ${!!token}`);
  console.log(`[DEBUG] AuthMiddleware - JWT_SECRET definido: ${!!JWT_SECRET}`);
  if (!token) {
    console.log(`[DEBUG] AuthMiddleware - Token não fornecido`);
    return res.status(401).json({ error: 'Token não fornecido' });
  }
  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) {
      console.log(`[DEBUG] AuthMiddleware - Token inválido:`, err.message);
      console.log(`[DEBUG] AuthMiddleware - Erro detalhado:`, err);
      return res.status(401).json({ error: 'Token inválido', details: err.message });
    }
    console.log(`[DEBUG] AuthMiddleware - Token válido, usuário: ${decoded.username}`);
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
router.get('/tabelas-preco', authMiddleware, async (req, res) => {
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
router.get('/eventos', authMiddleware, async (req, res) => {
  const eventos = await Evento.find().populate('tabelaPrecoId');
  res.json(eventos);
});

router.post('/eventos', authMiddleware, async (req, res) => {
  try {
    const { nome, data, local, tabelaPrecoId, valorFixo, criarPasta = false } = req.body;
    
    let pastaS3 = null;
    
    // Se solicitado, cria a pasta no S3
    if (criarPasta && nome) {
      try {
        pastaS3 = await criarPastaNoS3(nome);
        console.log(`Pasta criada no S3 para evento: ${nome}`);
      } catch (error) {
        console.error('Erro ao criar pasta no S3:', error);
        return res.status(500).json({ error: 'Erro ao criar pasta no S3' });
      }
    }
    
    const evento = await Evento.create({ 
      nome, 
      data, 
      local, 
      tabelaPrecoId, 
      valorFixo, 
      pastaS3 
    });
    
    await evento.populate('tabelaPrecoId');
    res.json(evento);
  } catch (error) {
    console.error('Erro ao criar evento:', error);
    res.status(500).json({ error: 'Erro ao criar evento' });
  }
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

// Rota de teste para indexação
router.post('/test-indexacao', authMiddleware, async (req, res) => {
  console.log('[DEBUG] ======== TESTE DE INDEXAÇÃO ========');
  console.log('[DEBUG] Usuário autenticado:', req.user?.username);
  res.json({ message: 'Teste de indexação funcionando!', user: req.user?.username });
});

// Consultar progresso de indexação
router.get('/eventos/:evento/progresso-indexacao', authMiddleware, (req, res) => {
  const { evento } = req.params;
  const progresso = progressoIndexacao.get(evento) || {
    ativo: false,
    total: 0,
    processadas: 0,
    indexadas: 0,
    erros: 0,
    fotoAtual: '',
    iniciadoEm: null,
    finalizadoEm: null
  };
  res.json(progresso);
});

// Função para normalizar nome do evento para uso no Rekognition
function normalizarNomeEvento(nomeEvento) {
  return nomeEvento
    .replace(/[^a-zA-Z0-9_.\-]/g, '_') // Substitui caracteres inválidos por underscore
    .replace(/_{2,}/g, '_') // Remove underscores duplos
    .replace(/^_|_$/g, '') // Remove underscores do início e fim
    .substring(0, 100); // Limita a 100 caracteres (limite do AWS)
}

// Função para normalizar nome do arquivo para uso como externalImageId
function normalizarNomeArquivo(nomeArquivo) {
  return nomeArquivo
    .replace(/[^a-zA-Z0-9_.\-:]/g, '_') // Substitui caracteres inválidos por underscore (inclui dois pontos)
    .replace(/_{2,}/g, '_') // Remove underscores duplos
    .replace(/^_|_$/g, '') // Remove underscores do início e fim
    .substring(0, 255); // Limita a 255 caracteres (limite do AWS para externalImageId)
}

// Indexar todas as fotos de um evento na AWS Rekognition
router.post('/eventos/:evento/indexar-fotos', authMiddleware, async (req, res) => {
  const { evento } = req.params;
  const nomeColecao = normalizarNomeEvento(evento);
  
  // Verificar se já há uma indexação em andamento
  const progressoAtual = progressoIndexacao.get(evento);
  if (progressoAtual && progressoAtual.ativo) {
    return res.status(409).json({ 
      erro: 'Indexação já em andamento para este evento',
      progresso: progressoAtual
    });
  }
  
  console.log(`[DEBUG] ======== INDEXAÇÃO DE FOTOS INICIADA ========`);
  console.log(`[DEBUG] Evento original: ${evento}`);
  console.log(`[DEBUG] Nome da coleção normalizado: ${nomeColecao}`);
  console.log(`[DEBUG] Usuário autenticado: ${req.user?.username}`);
  console.log(`[DEBUG] AWS_ACCESS_KEY_ID configurado: ${!!process.env.AWS_ACCESS_KEY_ID}`);
  console.log(`[DEBUG] AWS_SECRET_ACCESS_KEY configurado: ${!!process.env.AWS_SECRET_ACCESS_KEY}`);
  console.log(`[DEBUG] AWS_REGION configurado: ${process.env.AWS_REGION || 'us-east-1'}`);
  
  // Inicializar progresso
  progressoIndexacao.set(evento, {
    ativo: true,
    total: 0,
    processadas: 0,
    indexadas: 0,
    erros: 0,
    fotoAtual: 'Preparando indexação...',
    iniciadoEm: new Date(),
    finalizadoEm: null
  });
  
  // Responder imediatamente ao frontend
  res.json({ sucesso: true, message: 'Indexação iniciada em background' });
  
  try {
    // Cria/garante coleção na AWS Rekognition
    console.log('[DEBUG] Criando/garantindo coleção na AWS Rekognition...');
    await rekognitionService.criarColecao(nomeColecao);
    console.log('[DEBUG] Coleção pronta. Buscando coreografias e dias do evento...');

    // Busca todas as coreografias e dias do evento
    const data = await minioService.s3.listObjectsV2({
      Bucket: minioService.bucket,
      Prefix: `${bucketPrefix}/${evento}/`,
      Delimiter: '/',
    }).promise();
    const prefixes = (data.CommonPrefixes || []).map(p => p.Prefix.replace(`${bucketPrefix}/${evento}/`, '').replace('/', ''));
    const dias = prefixes.filter(nome => /^\d{2}-\d{2}-/.test(nome));
    let fotosParaIndexar = [];

    if (dias.length > 0) {
      console.log(`[DEBUG] Evento multi-dia (${dias.length} dias):`, dias);
      for (const dia of dias) {
        const coreografias = await minioService.listarCoreografias(evento, dia);
        console.log(`[DEBUG] Dia ${dia} - coreografias:`, coreografias.map(c => c.nome));
        for (const coreografia of coreografias) {
          const caminho = `${evento}/${dia}/${coreografia.nome}`;
          const fotos = await minioService.listarFotosPorCaminho(caminho);
          console.log(`[DEBUG] Dia ${dia} - Coreografia ${coreografia.nome} - ${fotos.length} fotos`);
          fotosParaIndexar.push(...fotos.map(f => ({ ...f, caminho })));
        }
      }
    } else {
      console.log('[DEBUG] Evento de um dia.');
      const coreografias = await minioService.listarCoreografias(evento);
      console.log('[DEBUG] Coreografias:', coreografias.map(c => c.nome));
      for (const coreografia of coreografias) {
        const caminho = `${evento}/${coreografia.nome}`;
        const fotos = await minioService.listarFotosPorCaminho(caminho);
        console.log(`[DEBUG] Coreografia ${coreografia.nome} - ${fotos.length} fotos`);
        fotosParaIndexar.push(...fotos.map(f => ({ ...f, caminho })));
      }
    }

    console.log(`[DEBUG] Total de fotos encontradas: ${fotosParaIndexar.length}`);
    
    // Verificar quais fotos já foram indexadas usando banco de dados
    console.log('[DEBUG] Verificando fotos já indexadas no banco de dados...');
    const fotosIndexadasDB = await FotoIndexada.listarPorEvento(evento, 'indexada');
    const nomesIndexados = fotosIndexadasDB.map(f => f.nomeArquivoNormalizado);
    console.log(`[DEBUG] Fotos já indexadas no banco: ${nomesIndexados.length}`);
    
    // Sincronizar com AWS Rekognition para garantir consistência
    console.log('[DEBUG] Sincronizando com AWS Rekognition...');
    const fotosJaIndexadasAWS = await rekognitionService.listarFacesIndexadas(nomeColecao);
    console.log(`[DEBUG] Fotos na coleção AWS Rekognition: ${fotosJaIndexadasAWS.length}`);
    
    // Filtrar apenas fotos que ainda não foram indexadas
    const fotosNaoIndexadas = fotosParaIndexar.filter(foto => {
      const nomeArquivoNormalizado = normalizarNomeArquivo(path.basename(foto.nome));
      const jaIndexadaDB = nomesIndexados.includes(nomeArquivoNormalizado);
      const jaIndexadaAWS = fotosJaIndexadasAWS.includes(nomeArquivoNormalizado);
      
      if (jaIndexadaDB && jaIndexadaAWS) {
        console.log(`[DEBUG] Pulando foto já indexada (DB + AWS): ${foto.nome}`);
        return false;
      } else if (jaIndexadaDB && !jaIndexadaAWS) {
        console.log(`[DEBUG] Foto no DB mas não no AWS - será reindexada: ${foto.nome}`);
        return true;
      } else if (!jaIndexadaDB && jaIndexadaAWS) {
        console.log(`[DEBUG] Foto no AWS mas não no DB - será registrada: ${foto.nome}`);
        // Registrar no banco de dados
        FotoIndexada.marcarComoIndexada({
          evento,
          nomeArquivo: path.basename(foto.nome),
          nomeArquivoNormalizado,
          caminhoCompleto: foto.caminho,
          s3Key: `${bucketPrefix}/${foto.caminho}/${foto.nome}`,
          colecaoRekognition: nomeColecao
        });
        return false;
      }
      
      return true; // Foto não indexada em lugar nenhum
    });
    
    console.log(`[DEBUG] Fotos para indexar (não indexadas): ${fotosNaoIndexadas.length}`);
    console.log(`[DEBUG] Fotos puladas (já indexadas): ${fotosParaIndexar.length - fotosNaoIndexadas.length}`);
    
    // Atualizar progresso com total de fotos não indexadas
    const progresso = progressoIndexacao.get(evento);
    progresso.total = fotosNaoIndexadas.length;
    progresso.fotoAtual = fotosNaoIndexadas.length === 0 ? 'Todas as fotos já foram indexadas!' : 'Iniciando indexação...';
    progressoIndexacao.set(evento, progresso);
    
    // Se não há fotos para indexar, finalizar imediatamente
    if (fotosNaoIndexadas.length === 0) {
      progresso.ativo = false;
      progresso.finalizadoEm = new Date();
      progresso.fotoAtual = `Indexação já completa! ${nomesIndexados.length} fotos já estavam indexadas.`;
      progressoIndexacao.set(evento, progresso);
      return;
    }
    
    // Configurações de processamento massivo TURBO
    const MAX_CONCURRENT = parseInt(process.env.INDEXACAO_CONCURRENT || '200'); // 200 fotos simultâneas
    const BATCH_SIZE = parseInt(process.env.INDEXACAO_BATCH_SIZE || '500'); // Lotes de 500 fotos
    const RETRY_ATTEMPTS = parseInt(process.env.INDEXACAO_RETRY_ATTEMPTS || '2'); // Menos retries para velocidade
    const RETRY_DELAY = parseInt(process.env.INDEXACAO_RETRY_DELAY || '500'); // Delay menor
    const TURBO_MODE = process.env.INDEXACAO_TURBO_MODE === 'true';
    
    console.log(`[DEBUG] Iniciando indexação ${TURBO_MODE ? 'TURBO' : 'PARALELA'}: ${MAX_CONCURRENT} concurrent, lotes de ${BATCH_SIZE}`);
    
    // Métricas de performance
    const inicioTempo = Date.now();
    const metricas = {
      inicioTempo,
      ultimoLog: inicioTempo,
      totalBytes: 0,
      fotosProcessadasUltimoLog: 0
    };
    
    // Contadores compartilhados (thread-safe com Map)
    let processadas = 0;
    let indexadas = 0;
    let erros = 0;
    
    // Função de retry com backoff exponencial
    const retryWithBackoff = async (fn, tentativas = RETRY_ATTEMPTS, delay = RETRY_DELAY) => {
      for (let i = 0; i < tentativas; i++) {
        try {
          return await fn();
        } catch (error) {
          const isLastAttempt = i === tentativas - 1;
          
          // Verifica se é um erro que vale a pena fazer retry
          const shouldRetry = 
            error.code === 'ThrottlingException' ||
            error.code === 'ProvisionedThroughputExceededException' ||
            error.code === 'ServiceUnavailable' ||
            error.code === 'InternalServerError' ||
            error.code === 'RequestTimeout' ||
            error.statusCode >= 500;
          
          if (isLastAttempt || !shouldRetry) {
            throw error;
          }
          
          const waitTime = delay * Math.pow(2, i); // Backoff exponencial
          console.log(`[RETRY] Tentativa ${i + 1}/${tentativas} falhou: ${error.message}. Aguardando ${waitTime}ms...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
      }
    };

    // Função para processar uma única foto com retry
    const processarFoto = async (foto, index) => {
      const nomeArquivoOriginal = path.basename(foto.nome);
      const nomeArquivoNormalizado = normalizarNomeArquivo(nomeArquivoOriginal);
      const s3Key = `${bucketPrefix}/${foto.caminho}/${foto.nome}`;
      
      try {
        console.log(`[DEBUG] [${index + 1}/${fotosNaoIndexadas.length}] Iniciando processamento: ${nomeArquivoOriginal}`);
        
        // Etapa 1: Baixar imagem do S3 com retry
        const objectData = await retryWithBackoff(async () => {
          return await minioService.s3.getObject({
            Bucket: minioService.bucket,
            Key: s3Key
          }).promise();
        });
        
        let buffer = objectData.Body;
        const extensaoOriginal = path.extname(nomeArquivoOriginal).toLowerCase();
        
        // Etapa 2 & 3: Conversão e metadados em paralelo (TURBO)
        const formatosNativos = ['.jpg', '.jpeg', '.png'];
        let metadata;
        
        if (!formatosNativos.includes(extensaoOriginal)) {
          if (TURBO_MODE) {
            // No modo turbo, fazer conversão e metadados em paralelo
            const [bufferConvertido, metadataOriginal] = await Promise.all([
              sharp(buffer).jpeg({ quality: 80 }).toBuffer(), // Qualidade menor para velocidade
              sharp(buffer).metadata()
            ]);
            buffer = bufferConvertido;
            metadata = { width: metadataOriginal.width, height: metadataOriginal.height };
          } else {
            buffer = await sharp(buffer).jpeg({ quality: 85 }).toBuffer();
            metadata = await sharp(buffer).metadata();
          }
        } else {
          metadata = await sharp(buffer).metadata();
        }
        
        // Etapa 4: Indexar na coleção Rekognition com retry
        const resultadoIndexacao = await retryWithBackoff(async () => {
          return await rekognitionService.indexarFace(nomeColecao, buffer, nomeArquivoNormalizado);
        });
        
        // Etapa 5: Salvar no banco de dados com retry
        const dadosFoto = {
          evento,
          nomeArquivo: nomeArquivoOriginal,
          nomeArquivoNormalizado,
          caminhoCompleto: foto.caminho,
          s3Key: s3Key,
          colecaoRekognition: nomeColecao,
          faceId: resultadoIndexacao.FaceRecords?.[0]?.Face?.FaceId,
          tamanhoArquivo: objectData.ContentLength,
          dimensoes: {
            largura: metadata.width,
            altura: metadata.height
          }
        };
        
        console.log(`[DEBUG] Salvando no banco - Evento: ${evento}, Foto: ${nomeArquivoNormalizado}`);
        
        const fotoSalva = await retryWithBackoff(async () => {
          return await FotoIndexada.marcarComoIndexada(dadosFoto);
        });
        
        console.log(`[DEBUG] ✅ Foto salva no banco com ID: ${fotoSalva._id}`);
        
        indexadas++;
        metricas.totalBytes += objectData.ContentLength || 0;
        
        // Log de performance a cada 50 fotos no modo turbo
        if (TURBO_MODE && processadas % 50 === 0) {
          const agora = Date.now();
          const tempoDecorrido = agora - metricas.inicioTempo;
          const fotosDesdeUltimoLog = processadas - metricas.fotosProcessadasUltimoLog;
          const tempoUltimoLog = agora - metricas.ultimoLog;
          const velocidade = fotosDesdeUltimoLog / (tempoUltimoLog / 1000);
          const mbProcessados = (metricas.totalBytes / 1024 / 1024).toFixed(1);
          
          console.log(`[TURBO] 🚀 ${processadas}/${fotosNaoIndexadas.length} | ${indexadas} indexadas | ${velocidade.toFixed(1)} fotos/s | ${mbProcessados}MB`);
          
          metricas.ultimoLog = agora;
          metricas.fotosProcessadasUltimoLog = processadas;
        }
        
        return { sucesso: true, foto: nomeArquivoOriginal };
        
      } catch (err) {
        erros++;
        console.error(`[ERRO] ❌ [${index + 1}/${fotosNaoIndexadas.length}] Falha definitiva: ${nomeArquivoOriginal} - ${err.message}`);
        
        // Salvar erro no banco de dados
        try {
          await FotoIndexada.marcarComErro(evento, nomeArquivoNormalizado, err.message);
        } catch (dbErr) {
          console.error(`[ERRO] Falha ao salvar erro no banco: ${dbErr.message}`);
        }
        
        return { sucesso: false, foto: nomeArquivoOriginal, erro: err.message };
      } finally {
        processadas++;
        
        // Atualizar progresso
        const progressoAtual = progressoIndexacao.get(evento);
        if (progressoAtual) {
          progressoAtual.processadas = processadas;
          progressoAtual.indexadas = indexadas;
          progressoAtual.erros = erros;
          progressoAtual.fotoAtual = `Processando em paralelo: ${processadas}/${fotosNaoIndexadas.length} (${indexadas} indexadas, ${erros} erros)`;
          progressoIndexacao.set(evento, progressoAtual);
        }
      }
    };
    
    // Processamento massivo TURBO - sem limitações artificiais
    const processarEmLotes = async () => {
      if (TURBO_MODE && fotosNaoIndexadas.length <= MAX_CONCURRENT) {
        // MODO ULTRA-TURBO: Processar tudo simultaneamente
        console.log(`[DEBUG] 🚀 MODO ULTRA-TURBO: Processando ${fotosNaoIndexadas.length} fotos SIMULTANEAMENTE!`);
        
        const promessasTodasFotos = fotosNaoIndexadas.map((foto, index) => 
          processarFoto(foto, index)
        );
        
        const resultados = await Promise.allSettled(promessasTodasFotos);
        
        const sucessos = resultados.filter(r => r.status === 'fulfilled' && r.value?.sucesso).length;
        const falhas = resultados.filter(r => r.status === 'rejected' || (r.status === 'fulfilled' && !r.value?.sucesso)).length;
        console.log(`[DEBUG] 🎯 TURBO CONCLUÍDO: ${sucessos} sucessos, ${falhas} falhas`);
        
      } else {
        // MODO TURBO com lotes massivos
        for (let i = 0; i < fotosNaoIndexadas.length; i += BATCH_SIZE) {
          const lote = fotosNaoIndexadas.slice(i, i + BATCH_SIZE);
          const loteNum = Math.floor(i / BATCH_SIZE) + 1;
          const totalLotes = Math.ceil(fotosNaoIndexadas.length / BATCH_SIZE);
          
          console.log(`[DEBUG] 🚀 Processando MEGA-LOTE ${loteNum}/${totalLotes}: ${lote.length} fotos (${i + 1}-${Math.min(i + BATCH_SIZE, fotosNaoIndexadas.length)})`);
          
          // Processar lote massivo com controle de concorrência
          const promessasLote = lote.map((foto, loteIndex) => 
            processarFoto(foto, i + loteIndex)
          );
          
          // Dividir em chunks apenas se necessário
          const resultados = [];
          if (promessasLote.length <= MAX_CONCURRENT) {
            // Executar tudo simultaneamente se cabe no limite
            const resultadosLote = await Promise.allSettled(promessasLote);
            resultados.push(...resultadosLote);
          } else {
            // Dividir em chunks do tamanho da concorrência
            for (let j = 0; j < promessasLote.length; j += MAX_CONCURRENT) {
              const chunk = promessasLote.slice(j, j + MAX_CONCURRENT);
              const resultadosChunk = await Promise.allSettled(chunk);
              resultados.push(...resultadosChunk);
            }
          }
          
          // Log do resultado do mega-lote
          const sucessos = resultados.filter(r => r.status === 'fulfilled' && r.value?.sucesso).length;
          const falhas = resultados.filter(r => r.status === 'rejected' || (r.status === 'fulfilled' && !r.value?.sucesso)).length;
          console.log(`[DEBUG] ✅ MEGA-LOTE ${loteNum} concluído: ${sucessos} sucessos, ${falhas} falhas`);
          
          // Pausa mínima entre mega-lotes (só se não for o último)
          if (i + BATCH_SIZE < fotosNaoIndexadas.length) {
            const pausaMs = TURBO_MODE ? 50 : 100;
            await new Promise(resolve => setTimeout(resolve, pausaMs));
          }
        }
      }
    };
    
    // Executar processamento paralelo
    await processarEmLotes();

    // Métricas finais de performance
    const tempoTotal = Date.now() - metricas.inicioTempo;
    const velocidadeMedia = fotosNaoIndexadas.length / (tempoTotal / 1000);
    const mbTotalProcessados = (metricas.totalBytes / 1024 / 1024).toFixed(1);
    
    console.log(`[DEBUG] 🎯 INDEXAÇÃO FINALIZADA!`);
    console.log(`[DEBUG] ⚡ Total: ${indexadas} indexadas de ${fotosNaoIndexadas.length} fotos`);
    console.log(`[DEBUG] ⏱️  Tempo: ${(tempoTotal / 1000).toFixed(1)}s | Velocidade: ${velocidadeMedia.toFixed(1)} fotos/s`);
    console.log(`[DEBUG] 💾 Dados: ${mbTotalProcessados}MB processados`);
    console.log(`[DEBUG] 🚀 Modo: ${TURBO_MODE ? 'TURBO' : 'NORMAL'} | Concorrência: ${MAX_CONCURRENT}`);
    
    // Invalidar cache do evento para refletir novos dados
    console.log(`[DEBUG] Invalidando cache do evento após indexação...`);
    await invalidarCacheEvento(evento);
    
    // Obter estatísticas finais do banco de dados
    const estatisticasFinais = await FotoIndexada.estatisticasEvento(evento);
    
    // Finalizar progresso
    const progressoFinal = progressoIndexacao.get(evento);
    progressoFinal.ativo = false;
    progressoFinal.finalizadoEm = new Date();
    
    const totalOriginal = fotosParaIndexar.length;
    const totalIndexadas = indexadas;
    
    progressoFinal.fotoAtual = `Concluído! ${totalIndexadas} novas fotos indexadas. Total no evento: ${totalOriginal} fotos. Banco de dados: ${estatisticasFinais.indexadas} indexadas, ${estatisticasFinais.erros} com erro.`;
    progressoIndexacao.set(evento, progressoFinal);
    
  } catch (error) {
    console.error('[ERRO] Erro ao indexar fotos do evento:', error);
    
    // Finalizar progresso com erro
    const progressoErro = progressoIndexacao.get(evento);
    if (progressoErro) {
      progressoErro.ativo = false;
      progressoErro.finalizadoEm = new Date();
      progressoErro.fotoAtual = `Erro durante indexação: ${error.message}`;
      progressoIndexacao.set(evento, progressoErro);
    }
  }
});

// Rota para obter estatísticas de indexação de um evento
router.get('/eventos/:evento/estatisticas-indexacao', authMiddleware, async (req, res) => {
  try {
    const { evento } = req.params;
    
    console.log(`[DEBUG] Buscando estatísticas para evento: ${evento}`);
    
    // Obter estatísticas do banco de dados
    const estatisticas = await FotoIndexada.estatisticasEvento(evento);
    
    console.log(`[DEBUG] Estatísticas do banco:`, estatisticas);
    
    // Obter total de fotos no S3 para comparação
    let totalFotosS3 = 0;
    try {
      const data = await minioService.s3.listObjectsV2({
        Bucket: minioService.bucket,
        Prefix: `${bucketPrefix}/${evento}/`,
        Delimiter: '/',
      }).promise();
      
      const prefixes = (data.CommonPrefixes || []).map(p => p.Prefix.replace(`${bucketPrefix}/${evento}/`, '').replace('/', ''));
      const dias = prefixes.filter(nome => /^\d{2}-\d{2}-/.test(nome));
      
      if (dias.length > 0) {
        // Evento multi-dia
        for (const dia of dias) {
          const coreografias = await minioService.listarCoreografias(evento, dia);
          for (const coreografia of coreografias) {
            const caminho = `${evento}/${dia}/${coreografia.nome}`;
            const fotos = await minioService.listarFotosPorCaminho(caminho);
            totalFotosS3 += fotos.length;
          }
        }
      } else {
        // Evento de um dia
        const coreografias = await minioService.listarCoreografias(evento);
        for (const coreografia of coreografias) {
          const caminho = `${evento}/${coreografia.nome}`;
          const fotos = await minioService.listarFotosPorCaminho(caminho);
          totalFotosS3 += fotos.length;
        }
      }
    } catch (s3Error) {
      console.error('Erro ao contar fotos no S3:', s3Error);
    }
    
    // Calcular percentual de indexação
    const percentualIndexado = totalFotosS3 > 0 ? ((estatisticas.indexadas / totalFotosS3) * 100).toFixed(1) : 0;
    
    res.json({
      evento,
      totalFotosS3,
      fotosIndexadas: estatisticas.indexadas,
      fotosComErro: estatisticas.erros,
      fotosProcessando: estatisticas.processando,
      fotosNaoIndexadas: Math.max(0, totalFotosS3 - estatisticas.total),
      percentualIndexado: parseFloat(percentualIndexado),
      ultimaIndexacao: await FotoIndexada.findOne({ evento, status: 'indexada' })
        .sort({ indexadaEm: -1 })
        .select('indexadaEm')
        .then(doc => doc?.indexadaEm || null)
    });
    
  } catch (error) {
    console.error('Erro ao obter estatísticas de indexação:', error);
    res.status(500).json({ 
      erro: 'Erro ao obter estatísticas de indexação', 
      detalhes: error.message 
    });
  }
});

// Rota de diagnóstico para verificar dados no banco
router.get('/eventos/:evento/diagnostico-indexacao', authMiddleware, async (req, res) => {
  try {
    const { evento } = req.params;
    
    console.log(`[DEBUG] Diagnóstico para evento: ${evento}`);
    
    // Buscar todas as fotos indexadas deste evento
    const fotosIndexadas = await FotoIndexada.find({ evento }).sort({ indexadaEm: -1 });
    
    // Estatísticas detalhadas
    const estatisticasPorStatus = await FotoIndexada.aggregate([
      { $match: { evento } },
      { $group: { _id: '$status', count: { $sum: 1 }, fotos: { $push: '$nomeArquivo' } } }
    ]);
    
    // Últimas 10 fotos indexadas
    const ultimasFotos = await FotoIndexada.find({ evento, status: 'indexada' })
      .sort({ indexadaEm: -1 })
      .limit(10)
      .select('nomeArquivo indexadaEm');
    
    const diagnostico = {
      evento,
      totalRegistros: fotosIndexadas.length,
      estatisticasPorStatus,
      ultimasFotos,
      primeiraIndexacao: fotosIndexadas.length > 0 ? fotosIndexadas[fotosIndexadas.length - 1].indexadaEm : null,
      ultimaIndexacao: fotosIndexadas.length > 0 ? fotosIndexadas[0].indexadaEm : null
    };
    
    console.log(`[DEBUG] Diagnóstico completo:`, diagnostico);
    
    res.json(diagnostico);
    
  } catch (error) {
    console.error('Erro no diagnóstico:', error);
    res.status(500).json({ 
      erro: 'Erro no diagnóstico', 
      detalhes: error.message 
    });
  }
});

// Rota para invalidar cache de um evento específico
router.post('/eventos/:evento/invalidar-cache', authMiddleware, async (req, res) => {
  try {
    const { evento } = req.params;
    
    console.log(`[DEBUG] Invalidando cache para evento: ${evento}`);
    
    await invalidarCacheEvento(evento);
    
    res.json({ 
      sucesso: true, 
      message: `Cache invalidado para evento: ${evento}` 
    });
    
  } catch (error) {
    console.error('Erro ao invalidar cache:', error);
    res.status(500).json({ 
      erro: 'Erro ao invalidar cache', 
      detalhes: error.message 
    });
  }
});

// Buscar fotos por selfie usando AWS Rekognition
router.post('/eventos/:evento/buscar-fotos-por-selfie', authMiddleware, async (req, res) => {
  const { evento } = req.params;
  const nomeColecao = normalizarNomeEvento(evento);
  console.log(`[DEBUG] ======== BUSCA POR SELFIE INICIADA ========`);
  console.log(`[DEBUG] Evento original: ${evento}`);
  console.log(`[DEBUG] Nome da coleção normalizado: ${nomeColecao}`);

  try {
    // Verificar se há arquivo de imagem no body
    if (!req.file && !req.body.imagemBase64) {
      return res.status(400).json({ erro: 'Imagem não fornecida' });
    }

    let imagemBuffer;
    if (req.file) {
      imagemBuffer = req.file.buffer;
    } else {
      // Converter base64 para buffer
      const base64Data = req.body.imagemBase64.replace(/^data:image\/[a-z]+;base64,/, '');
      imagemBuffer = Buffer.from(base64Data, 'base64');
    }

    console.log(`[DEBUG] Tamanho da selfie: ${imagemBuffer.length} bytes`);
    
    // Detectar formato da selfie e converter se necessário
    const metadata = await sharp(imagemBuffer).metadata();
    const formatoSelfie = metadata.format;
    console.log(`[DEBUG] Formato da selfie: ${formatoSelfie}`);
    
    const formatosNativos = ['jpeg', 'jpg', 'png'];
    if (!formatosNativos.includes(formatoSelfie)) {
      console.log(`[DEBUG] Convertendo selfie de ${formatoSelfie.toUpperCase()} para JPEG...`);
      imagemBuffer = await sharp(imagemBuffer)
        .jpeg({ quality: 85 })
        .toBuffer();
      console.log(`[DEBUG] Conversão da selfie concluída. Novo tamanho: ${imagemBuffer.length} bytes`);
    } else {
      console.log(`[DEBUG] Formato ${formatoSelfie.toUpperCase()} já é compatível com AWS Rekognition.`);
    }

    console.log(`[DEBUG] Buscando faces na coleção: ${nomeColecao}`);
    // Buscar faces similares na coleção
    const resultado = await rekognitionService.buscarFacePorImagem(nomeColecao, imagemBuffer);
    
    console.log(`[DEBUG] Faces encontradas: ${resultado.FaceMatches?.length || 0}`);
    
    if (!resultado.FaceMatches || resultado.FaceMatches.length === 0) {
      return res.json({ fotos: [], total: 0 });
    }

    // Extrair nomes das fotos dos resultados (já normalizados)
    const nomesFotosNormalizados = resultado.FaceMatches.map(match => match.Face.ExternalImageId);
    console.log(`[DEBUG] Nomes das fotos encontradas (normalizados):`, nomesFotosNormalizados);

    // Buscar as fotos completas no MinIO baseado nos nomes
    const fotosEncontradas = [];
    
    console.log(`[DEBUG] ===== INICIANDO BUSCA DAS FOTOS =====`);
    console.log(`[DEBUG] Procurando por ${nomesFotosNormalizados.length} fotos:`, nomesFotosNormalizados);
    
    // Teste da função de normalização
    const testeNormalizacao = [
      '3425_B (110).webp',
      '3425_B (109).webp', 
      '3425_B (193).webp'
    ];
    console.log(`[DEBUG] Teste de normalização:`);
    testeNormalizacao.forEach(nome => {
      const normalizado = normalizarNomeArquivo(nome);
      console.log(`[DEBUG] '${nome}' => '${normalizado}'`);
    });
    
    // Buscar em todas as coreografias do evento usando a mesma lógica do indexador
    const data = await minioService.s3.listObjectsV2({
      Bucket: minioService.bucket,
      Prefix: `${bucketPrefix}/${evento}/`,
      Delimiter: '/',
    }).promise();
    const prefixes = (data.CommonPrefixes || []).map(p => p.Prefix.replace(`${bucketPrefix}/${evento}/`, '').replace('/', ''));
    const dias = prefixes.filter(nome => /^\d{2}-\d{2}-/.test(nome));

    if (dias.length > 0) {
      // Evento multi-dia
      for (const dia of dias) {
        const coreografias = await minioService.listarCoreografias(evento, dia);
        for (const coreografia of coreografias) {
          const fotos = await minioService.listarFotosPorCaminho(`${evento}/${dia}/${coreografia.nome}`);
          const fotosCorrespondentes = fotos.filter(foto => {
            const nomeArquivoNormalizado = normalizarNomeArquivo(path.basename(foto.nome));
            // LOG para debug
            if (nomesFotosNormalizados.includes(nomeArquivoNormalizado)) {
              console.log(`[DEBUG] Match encontrado: ${foto.nome} => ${nomeArquivoNormalizado}`);
            }
            return nomesFotosNormalizados.some(nome => nomeArquivoNormalizado === nome);
          });
          fotosEncontradas.push(...fotosCorrespondentes);
        }
      }
    } else {
      // Evento de um dia
      const coreografias = await minioService.listarCoreografias(evento);
      for (const coreografia of coreografias) {
        const fotos = await minioService.listarFotosPorCaminho(`${evento}/${coreografia.nome}`);
        console.log(`[DEBUG] Processando coreografia: ${coreografia.nome} com ${fotos.length} fotos`);
        
        // Log das primeiras 10 fotos para debug
        const primeirasFotos = fotos.slice(0, 10);
        primeirasFotos.forEach((foto, index) => {
          const nomeOriginal = path.basename(foto.nome);
          const nomeNormalizado = normalizarNomeArquivo(nomeOriginal);
          console.log(`[DEBUG] Foto ${index + 1}: original='${nomeOriginal}' normalizado='${nomeNormalizado}'`);
        });
        
        const fotosCorrespondentes = fotos.filter(foto => {
          const nomeArquivoNormalizado = normalizarNomeArquivo(path.basename(foto.nome));
          // LOG para debug
          if (nomesFotosNormalizados.includes(nomeArquivoNormalizado)) {
            console.log(`[DEBUG] ✅ MATCH ENCONTRADO: ${foto.nome} => ${nomeArquivoNormalizado}`);
          }
          return nomesFotosNormalizados.some(nome => nomeArquivoNormalizado === nome);
        });
        fotosEncontradas.push(...fotosCorrespondentes);
      }
    }

    // LOG extra para depuração
    console.log(`[DEBUG] ===== RESULTADO FINAL =====`);
    console.log(`[DEBUG] Total de fotos encontradas: ${fotosEncontradas.length}`);
    if (fotosEncontradas.length === 0) {
      console.log('[DEBUG] ❌ Nenhuma foto encontrada!');
      console.log('[DEBUG] Nomes procurados:', nomesFotosNormalizados);
      console.log('[DEBUG] Verifique se a função normalizarNomeArquivo está funcionando corretamente');
    } else {
      console.log('[DEBUG] ✅ Fotos encontradas:', fotosEncontradas.map(f => f.nome));
    }
    res.json({ fotos: fotosEncontradas, total: fotosEncontradas.length });

  } catch (error) {
    console.error('[ERRO] Erro ao buscar fotos por selfie:', error);
    res.status(500).json({ erro: 'Erro ao buscar fotos por selfie', detalhes: error.message });
  }
});


module.exports = router; 