const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const Evento = require('../models/evento');
const Usuario = require('../models/usuario');
const Pedido = require('../models/pedido');
const { listarEventos } = require('../services/minio');
const TabelaPreco = require('../models/tabelaPreco');
const Cupom = require('../models/cupom');
const { clearAllCache } = require('../services/cache');
const { preCarregarDadosPopulares } = require('../services/minio');
const minioService = require('../services/minio');
const rekognitionService = require('../services/rekognition');
const path = require('path');
const sharp = require('sharp');

// Configuração do multer para upload de arquivos
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB
  },
  fileFilter: (req, file, cb) => {
    // Aceitar apenas imagens
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Apenas arquivos de imagem são permitidos'), false);
    }
  }
});

// Armazenamento em memória para progresso de indexação
const progressoIndexacao = new Map();

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'segredo123';

// Middleware para proteger rotas
function authMiddleware(req, res, next) {
  // console.log(`[DEBUG] AuthMiddleware - Rota: ${req.method} ${req.path}`);
  const token = req.headers['authorization']?.split(' ')[1];
  // console.log(`[DEBUG] AuthMiddleware - Token presente: ${!!token}`);
  if (!token) {
    // console.log(`[DEBUG] AuthMiddleware - Token não fornecido`);
    return res.status(401).json({ error: 'Token não fornecido' });
  }
  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) {
      // console.log(`[DEBUG] AuthMiddleware - Token inválido:`, err.message);
      return res.status(401).json({ error: 'Token inválido' });
    }
    // console.log(`[DEBUG] AuthMiddleware - Token válido, usuário: ${decoded.username}`);
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
  
  // Converter capasDias de Map para objeto para serialização JSON
  const eventosProcessados = eventos.map(evento => {
    const eventoObj = evento.toObject();
    if (eventoObj.capasDias) {
      // Converter Map para objeto e mapear chaves normalizadas para originais
      const capasObj = {};
      for (const [chaveNormalizada, urlCapa] of eventoObj.capasDias) {
        const diaOriginal = obterChaveOriginal(chaveNormalizada, eventoObj.diasSelecionados);
        if (diaOriginal) {
          capasObj[diaOriginal] = urlCapa;
        }
      }
      eventoObj.capasDias = capasObj;
    }
    return eventoObj;
  });
  
  res.json(eventosProcessados);
});

router.post('/eventos', authMiddleware, async (req, res) => {
  const { nome, data, local, tabelaPrecoId, valorFixo, bannerVale, bannerVideo, bannerPoster, valorVale, valorVideo, valorPoster, diasSelecionados } = req.body;
  const evento = await Evento.create({ 
    nome, 
    data, 
    local, 
    tabelaPrecoId, 
    valorFixo,
    bannerVale: !!bannerVale,
    bannerVideo: !!bannerVideo,
    bannerPoster: !!bannerPoster,
    valorVale: valorVale || 0,
    valorVideo: valorVideo || 0,
    valorPoster: valorPoster || 0,
    diasSelecionados: diasSelecionados || []
  });
  await evento.populate('tabelaPrecoId');
  res.json(evento);
});

router.put('/eventos/:id', authMiddleware, async (req, res) => {
  const { nome, data, local, tabelaPrecoId, valorFixo, bannerVale, bannerVideo, bannerPoster, valorVale, valorVideo, valorPoster, diasSelecionados } = req.body;
  const evento = await Evento.findByIdAndUpdate(req.params.id, { 
    nome, 
    data, 
    local, 
    tabelaPrecoId, 
    valorFixo,
    bannerVale: !!bannerVale,
    bannerVideo: !!bannerVideo,
    bannerPoster: !!bannerPoster,
    valorVale: valorVale || 0,
    valorVideo: valorVideo || 0,
    valorPoster: valorPoster || 0,
    diasSelecionados: diasSelecionados || []
  }, { new: true });
  await evento.populate('tabelaPrecoId');
  res.json(evento);
});

// Rota para buscar evento por nome (para o frontend)
router.get('/eventos/nome/:nome', async (req, res) => {
  try {
    const evento = await Evento.findOne({ nome: req.params.nome }).populate('tabelaPrecoId');
    if (!evento) {
      return res.status(404).json({ error: 'Evento não encontrado' });
    }
    
    // Converter capasDias de Map para objeto para serialização JSON
    const eventoObj = evento.toObject();
    if (eventoObj.capasDias) {
      // Converter Map para objeto e mapear chaves normalizadas para originais
      const capasObj = {};
      for (const [chaveNormalizada, urlCapa] of eventoObj.capasDias) {
        const diaOriginal = obterChaveOriginal(chaveNormalizada, eventoObj.diasSelecionados);
        if (diaOriginal) {
          capasObj[diaOriginal] = urlCapa;
        }
      }
      eventoObj.capasDias = capasObj;
    }
    
    res.json(eventoObj);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar evento' });
  }
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

// Lista pastas de um evento específico no MinIO (para seleção de dias)
router.get('/eventos-minio/:eventoNome/pastas', authMiddleware, async (req, res) => {
  try {
    const { eventoNome } = req.params;
    const { s3, bucket } = minioService;
    
    // Buscar subpastas do evento
    const prefix = `${eventoNome}/`;
    const data = await s3.listObjectsV2({
      Bucket: bucket,
      Prefix: prefix,
      Delimiter: '/',
      MaxKeys: 100
    }).promise();

    // Processar pastas encontradas
    const pastas = (data.CommonPrefixes || []).map(p => {
      const nome = p.Prefix.replace(prefix, '').replace('/', '');
      return { nome };
    });

    res.json(pastas);
  } catch (error) {
    console.error('Erro ao listar pastas do evento:', error);
    res.status(500).json({ error: 'Erro ao listar pastas do evento' });
  }
});

// Função para normalizar chaves do Map (remover caracteres problemáticos)
function normalizarChaveMap(chave) {
  return chave.replace(/[.]/g, '_').replace(/[^a-zA-Z0-9_]/g, '_');
}

// Função para obter chave original a partir da normalizada
function obterChaveOriginal(chaveNormalizada, diasSelecionados) {
  return diasSelecionados.find(dia => normalizarChaveMap(dia) === chaveNormalizada);
}

// Upload de capa para um dia específico do evento
router.post('/eventos/:eventoId/dias/:diaNome/capa', authMiddleware, upload.single('capa'), async (req, res) => {
  try {
    const { eventoId, diaNome } = req.params;
    const { s3, bucket } = minioService;
    
    if (!req.file) {
      return res.status(400).json({ error: 'Nenhuma imagem foi enviada' });
    }
    
    // Buscar o evento
    const evento = await Evento.findById(eventoId);
    if (!evento) {
      return res.status(404).json({ error: 'Evento não encontrado' });
    }
    
    // Verificar se o dia está na lista de dias selecionados
    if (!evento.diasSelecionados.includes(diaNome)) {
      return res.status(400).json({ error: 'Dia não está na lista de dias selecionados' });
    }
    
    // Gerar nome único para a capa
    const extensao = req.file.originalname.split('.').pop();
    const nomeArquivo = `capas/${eventoId}/${diaNome}_capa.${extensao}`;
    
    // Fazer upload para o MinIO
    await s3.putObject({
      Bucket: bucket,
      Key: nomeArquivo,
      Body: req.file.buffer,
      ContentType: req.file.mimetype
    }).promise();
    
    // Gerar URL pública da imagem (sem assinatura)
    const urlCapa = `${process.env.MINIO_ENDPOINT}/${bucket}/${nomeArquivo}`;
    
    // Atualizar o evento com a URL da capa
    if (!evento.capasDias) {
      evento.capasDias = new Map();
    }
    
    // Usar chave normalizada para o Map
    const chaveNormalizada = normalizarChaveMap(diaNome);
    evento.capasDias.set(chaveNormalizada, urlCapa);
    await evento.save();
    
    res.json({ 
      success: true, 
      urlCapa,
      message: `Capa do dia "${diaNome}" enviada com sucesso!` 
    });
    
  } catch (error) {
    console.error('Erro ao fazer upload da capa:', error);
    res.status(500).json({ error: 'Erro ao fazer upload da capa' });
  }
});

// Remover capa de um dia específico
router.delete('/eventos/:eventoId/dias/:diaNome/capa', authMiddleware, async (req, res) => {
  try {
    const { eventoId, diaNome } = req.params;
    const { s3, bucket } = minioService;
    
    // Buscar o evento
    const evento = await Evento.findById(eventoId);
    if (!evento) {
      return res.status(404).json({ error: 'Evento não encontrado' });
    }
    
    // Usar chave normalizada para buscar no Map
    const chaveNormalizada = normalizarChaveMap(diaNome);
    
    // Verificar se existe capa para este dia
    if (!evento.capasDias || !evento.capasDias.has(chaveNormalizada)) {
      return res.status(404).json({ error: 'Capa não encontrada para este dia' });
    }
    
    // Remover do MinIO (opcional - pode manter para histórico)
    // const urlCapa = evento.capasDias.get(chaveNormalizada);
    // const key = urlCapa.split('/').slice(-2).join('/'); // Extrair chave do MinIO
    
    // Remover do evento
    evento.capasDias.delete(chaveNormalizada);
    await evento.save();
    
    res.json({ 
      success: true, 
      message: `Capa do dia "${diaNome}" removida com sucesso!` 
    });
    
  } catch (error) {
    console.error('Erro ao remover capa:', error);
    res.status(500).json({ error: 'Erro ao remover capa' });
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
      .populate('usuario', 'nome email telefone cpfCnpj rua numero complemento bairro cidade estado cep')
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
      .populate('usuario', 'nome email telefone cpfCnpj cep rua numero complemento bairro cidade estado');
    
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
    const statusValidos = ['pendente', 'pago', 'preparando_pedido', 'enviado', 'cancelado'];
    
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
    await pedido.populate('usuario', 'nome email telefone cpfCnpj rua numero complemento bairro cidade estado cep');
    
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
    await pedido.populate('usuario', 'nome email telefone cpfCnpj rua numero complemento bairro cidade estado cep');
    
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
    await pedido.populate('usuario', 'nome email telefone cpfCnpj rua numero complemento bairro cidade estado cep');
    
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
                totalPedidos: { 
                  $sum: { $cond: [{ $ne: ['$status', 'cancelado'] }, 1, 0] }
                },
                totalReceita: { 
                  $sum: { $cond: [{ $ne: ['$status', 'cancelado'] }, '$valorTotal', 0] }
                },
                receitaPendente: {
                  $sum: { $cond: [{ $eq: ['$status', 'pendente'] }, '$valorTotal', 0] }
                },
                receitaPaga: {
                  $sum: { $cond: [{ $eq: ['$status', 'pago'] }, '$valorTotal', 0] }
                },
                receitaPreparando: {
                  $sum: { $cond: [{ $eq: ['$status', 'preparando_pedido'] }, '$valorTotal', 0] }
                },
                receitaEnviado: {
                  $sum: { $cond: [{ $eq: ['$status', 'enviado'] }, '$valorTotal', 0] }
                },
                receitaCancelada: {
                  $sum: { $cond: [{ $eq: ['$status', 'cancelado'] }, '$valorTotal', 0] }
                }
              }
            }
          ],
          // Estatísticas do período
          periodoStats: [
            { 
              $match: { 
                dataCriacao: { $gte: dataInicio },
                status: { $ne: 'cancelado' }
              }
            },
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
    await pedido.populate('usuario', 'nome email telefone cpfCnpj rua numero complemento bairro cidade estado cep');
    
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
    await pedido.populate('usuario', 'nome email telefone cpfCnpj rua numero complemento bairro cidade estado cep');
    
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
      Prefix: `${evento}/`,
      Delimiter: '/',
    }).promise();
    const prefixes = (data.CommonPrefixes || []).map(p => p.Prefix.replace(`${evento}/`, '').replace('/', ''));
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

    console.log(`[DEBUG] Total de fotos para indexar: ${fotosParaIndexar.length}`);
    
    // Atualizar progresso com total de fotos
    const progresso = progressoIndexacao.get(evento);
    progresso.total = fotosParaIndexar.length;
    progresso.fotoAtual = 'Iniciando indexação...';
    progressoIndexacao.set(evento, progresso);
    
    // Indexar cada foto na coleção Rekognition
    let indexadas = 0;
    for (let i = 0; i < fotosParaIndexar.length; i++) {
      const foto = fotosParaIndexar[i];
      try {
        // Atualizar progresso
        const progressoAtual = progressoIndexacao.get(evento);
        progressoAtual.processadas = i + 1;
        progressoAtual.fotoAtual = `Processando: ${path.basename(foto.nome)} (${i + 1}/${fotosParaIndexar.length})`;
        progressoIndexacao.set(evento, progressoAtual);
        
        // Construir a chave S3 correta a partir do caminho e nome da foto
        const s3Key = `${foto.caminho}/${foto.nome}`;
        console.log(`[DEBUG] [${i + 1}/${fotosParaIndexar.length}] Baixando foto via S3: ${s3Key}`);
        // Baixar imagem diretamente do MinIO usando S3 client
        const objectData = await minioService.s3.getObject({
          Bucket: minioService.bucket,
          Key: s3Key
        }).promise();
        
        let buffer = objectData.Body;
        const nomeArquivoOriginal = path.basename(foto.nome);
        const nomeArquivoNormalizado = normalizarNomeArquivo(nomeArquivoOriginal);
        const extensaoOriginal = path.extname(nomeArquivoOriginal).toLowerCase();
        
        console.log(`[DEBUG] Indexando foto na coleção Rekognition:`);
        console.log(`[DEBUG]   Nome original: ${nomeArquivoOriginal}`);
        console.log(`[DEBUG]   Nome normalizado: ${nomeArquivoNormalizado}`);
        console.log(`[DEBUG]   Extensão: ${extensaoOriginal}`);
        
        // Converter para JPEG se não for um formato nativo do Rekognition
        const formatosNativos = ['.jpg', '.jpeg', '.png'];
        if (!formatosNativos.includes(extensaoOriginal)) {
          console.log(`[DEBUG] Convertendo ${extensaoOriginal.toUpperCase()} para JPEG...`);
          buffer = await sharp(buffer)
            .jpeg({ quality: 85 })
            .toBuffer();
          console.log(`[DEBUG] Conversão concluída.`);
        } else {
          console.log(`[DEBUG] Formato ${extensaoOriginal.toUpperCase()} já é compatível com AWS Rekognition.`);
        }
        
        // Indexar na coleção Rekognition
        await rekognitionService.indexarFace(nomeColecao, buffer, nomeArquivoNormalizado);
        indexadas++;
        
        // Atualizar progresso com sucesso
        const progressoSucesso = progressoIndexacao.get(evento);
        progressoSucesso.indexadas = indexadas;
        progressoIndexacao.set(evento, progressoSucesso);
        
        console.log(`[DEBUG] [${i + 1}/${fotosParaIndexar.length}] Foto indexada com sucesso: ${nomeArquivoNormalizado}`);
      } catch (err) {
        // Atualizar progresso com erro
        const progressoErro = progressoIndexacao.get(evento);
        progressoErro.erros++;
        progressoIndexacao.set(evento, progressoErro);
        
        console.error(`[ERRO] [${i + 1}/${fotosParaIndexar.length}] Erro ao indexar foto: ${foto.nome} | Motivo: ${err.message}`);
      }
    }

    console.log(`[DEBUG] Indexação finalizada. Total indexadas: ${indexadas} de ${fotosParaIndexar.length}`);
    
    // Finalizar progresso
    const progressoFinal = progressoIndexacao.get(evento);
    progressoFinal.ativo = false;
    progressoFinal.finalizadoEm = new Date();
    progressoFinal.fotoAtual = `Concluído! ${indexadas} fotos indexadas de ${fotosParaIndexar.length}`;
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
      Prefix: `${evento}/`,
      Delimiter: '/',
    }).promise();
    const prefixes = (data.CommonPrefixes || []).map(p => p.Prefix.replace(`${evento}/`, '').replace('/', ''));
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

// =================== ROTAS DE CUPONS ===================

// Listar todos os cupons
router.get('/cupons', authMiddleware, async (req, res) => {
  try {
    const cupons = await Cupom.find().sort({ createdAt: -1 });
    res.json(cupons);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar cupons' });
  }
});

// Criar novo cupom
router.post('/cupons', authMiddleware, async (req, res) => {
  try {
    const { 
      codigo, 
      descricao, 
      tipoDesconto, 
      valorDesconto, 
      quantidadeTotal, 
      limitarPorUsuario,
      dataExpiracao
    } = req.body;

    // Validações
    if (!codigo || !descricao || !tipoDesconto || valorDesconto === undefined || !quantidadeTotal) {
      return res.status(400).json({ error: 'Campos obrigatórios não preenchidos' });
    }

    if (tipoDesconto === 'porcentagem' && valorDesconto > 100) {
      return res.status(400).json({ error: 'Desconto em porcentagem não pode ser maior que 100%' });
    }

    const cupom = new Cupom({
      codigo: codigo.toUpperCase(),
      descricao,
      tipoDesconto,
      valorDesconto: Number(valorDesconto),
      quantidadeTotal: Number(quantidadeTotal),
      limitarPorUsuario: !!limitarPorUsuario,
      dataExpiracao: dataExpiracao ? new Date(dataExpiracao) : null
    });

    await cupom.save();
    res.json(cupom);
  } catch (error) {
    if (error.code === 11000) {
      res.status(400).json({ error: 'Código do cupom já existe' });
    } else {
      res.status(500).json({ error: 'Erro ao criar cupom' });
    }
  }
});

// Editar cupom
router.put('/cupons/:id', authMiddleware, async (req, res) => {
  try {
    const { 
      codigo, 
      descricao, 
      tipoDesconto, 
      valorDesconto, 
      quantidadeTotal, 
      limitarPorUsuario,
      dataExpiracao,
      ativo
    } = req.body;

    if (tipoDesconto === 'porcentagem' && valorDesconto > 100) {
      return res.status(400).json({ error: 'Desconto em porcentagem não pode ser maior que 100%' });
    }

    const cupom = await Cupom.findByIdAndUpdate(req.params.id, {
      codigo: codigo ? codigo.toUpperCase() : undefined,
      descricao,
      tipoDesconto,
      valorDesconto: valorDesconto !== undefined ? Number(valorDesconto) : undefined,
      quantidadeTotal: quantidadeTotal !== undefined ? Number(quantidadeTotal) : undefined,
      limitarPorUsuario: limitarPorUsuario !== undefined ? !!limitarPorUsuario : undefined,
      dataExpiracao: dataExpiracao ? new Date(dataExpiracao) : null,
      ativo: ativo !== undefined ? !!ativo : undefined
    }, { new: true, runValidators: true });

    if (!cupom) {
      return res.status(404).json({ error: 'Cupom não encontrado' });
    }

    res.json(cupom);
  } catch (error) {
    if (error.code === 11000) {
      res.status(400).json({ error: 'Código do cupom já existe' });
    } else {
      res.status(500).json({ error: 'Erro ao editar cupom' });
    }
  }
});

// Deletar cupom
router.delete('/cupons/:id', authMiddleware, async (req, res) => {
  try {
    const cupom = await Cupom.findByIdAndDelete(req.params.id);
    if (!cupom) {
      return res.status(404).json({ error: 'Cupom não encontrado' });
    }
    res.json({ message: 'Cupom deletado com sucesso' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao deletar cupom' });
  }
});

// Validar cupom (para uso no frontend) - APENAS VALIDAÇÃO, NÃO REGISTRA USO
router.post('/cupons/validar', async (req, res) => {
  try {
    const { codigo, usuarioId, valorTotal } = req.body;

    if (!codigo) {
      return res.status(400).json({ error: 'Código do cupom é obrigatório' });
    }

    const cupom = await Cupom.findOne({ codigo: codigo.toUpperCase() });
    
    if (!cupom) {
      return res.status(404).json({ error: 'Cupom não encontrado' });
    }

    // Verificar se cupom é válido
    const validacao = cupom.isValido();
    if (!validacao.valido) {
      return res.status(400).json({ error: validacao.motivo });
    }

    // Verificar se usuário já usou (se aplicável) - SÓ VERIFICA, NÃO REGISTRA
    if (usuarioId && cupom.usuarioJaUsou(usuarioId)) {
      return res.status(400).json({ 
        error: 'Este cupom já foi utilizado por você. Cada usuário pode usar este cupom apenas uma vez.' 
      });
    }

    // Calcular desconto
    const valorDesconto = valorTotal ? cupom.calcularDesconto(Number(valorTotal)) : 0;

    res.json({
      cupom: {
        id: cupom._id,
        codigo: cupom.codigo,
        descricao: cupom.descricao,
        tipoDesconto: cupom.tipoDesconto,
        valorDesconto: cupom.valorDesconto
      },
      desconto: valorDesconto,
      percentual: cupom.tipoDesconto === 'porcentagem' ? cupom.valorDesconto : null
    });
  } catch (error) {
    console.error('[Cupom] Erro ao validar cupom:', error);
    res.status(500).json({ error: 'Erro ao validar cupom' });
  }
});

// Rota para limpar cache (debug)
router.post('/limpar-cache', authMiddleware, async (req, res) => {
  try {
    const redisClient = require('../services/cache').redisClient;
    if (redisClient) {
      await redisClient.flushall();
      console.log('[CACHE] Cache Redis limpo');
    }
    
    // Limpar cache em memória também se existir
    const memoryCache = require('../services/cache').memoryCache;
    if (memoryCache && typeof memoryCache.clear === 'function') {
      memoryCache.clear();
      console.log('[CACHE] Cache em memória limpo');
    }
    
    res.json({ success: true, message: 'Cache limpo com sucesso' });
  } catch (error) {
    console.error('[CACHE] Erro ao limpar cache:', error);
    res.status(500).json({ error: 'Erro ao limpar cache' });
  }
});

// Rotas para as novas funcionalidades
// Enviar mensagem para cliente
router.post('/enviar-mensagem', authMiddleware, async (req, res) => {
  try {
    const { pedidoId, telefone, mensagem } = req.body;
    
    console.log(`[ADMIN_MENSAGEM] Enviando para ${telefone}: ${mensagem}`);
    
    // Usar o mesmo serviço de WhatsApp
    const { sendOrderSummary } = require('../services/evolutionapi');
    await sendOrderSummary({ numero: telefone, mensagem });
    
    console.log(`[ADMIN_MENSAGEM] Mensagem enviada com sucesso para ${telefone}`);
    
    // Salvar log da mensagem
    const pedido = await Pedido.findById(pedidoId);
    if (pedido) {
      pedido.logs = pedido.logs || [];
      pedido.logs.push({
        data: new Date(),
        usuario: req.user.username,
        acao: 'mensagem_enviada',
        descricao: `Mensagem enviada para ${telefone}`
      });
      await pedido.save();
    }
    
    res.json({ success: true, message: 'Mensagem enviada com sucesso' });
  } catch (error) {
    console.error('[ADMIN_MENSAGEM] Erro ao enviar mensagem:', error);
    res.status(500).json({ error: 'Erro ao enviar mensagem: ' + error.message });
  }
});

// Atualizar dados da nota fiscal
router.put('/pedidos/:id/nota-fiscal', authMiddleware, async (req, res) => {
  try {
    const { numeroNotaFiscal, periodoNotaFiscal } = req.body;
    const pedido = await Pedido.findById(req.params.id).populate('usuario');
    
    if (!pedido) {
      return res.status(404).json({ error: 'Pedido não encontrado' });
    }
    
    const dadosAnteriores = {
      numero: pedido.numeroNotaFiscal,
      periodo: pedido.periodoNotaFiscal
    };
    
    // Atualizar dados
    if (numeroNotaFiscal !== undefined) {
      pedido.numeroNotaFiscal = numeroNotaFiscal;
    }
    if (periodoNotaFiscal !== undefined) {
      pedido.periodoNotaFiscal = periodoNotaFiscal;
    }
    
    // Adicionar log detalhado
    pedido.logs = pedido.logs || [];
    const alteracoes = [];
    if (numeroNotaFiscal !== dadosAnteriores.numero) {
      alteracoes.push(`Número: "${dadosAnteriores.numero}" → "${numeroNotaFiscal}"`);
    }
    if (periodoNotaFiscal !== dadosAnteriores.periodo) {
      alteracoes.push(`Período: "${dadosAnteriores.periodo}" → "${periodoNotaFiscal}"`);
    }
    
    pedido.logs.push({
      data: new Date(),
      usuario: req.user.username,
      acao: 'nota_fiscal_atualizada',
      descricao: `Dados da nota fiscal atualizados: ${alteracoes.join(', ')}`
    });
    
    await pedido.save();
    res.json(pedido);
  } catch (error) {
    console.error('[NOTA_FISCAL] Erro ao atualizar:', error);
    res.status(500).json({ error: 'Erro ao atualizar nota fiscal' });
  }
});

// Atualizar status da nota fiscal
router.put('/pedidos/:id/status-nota-fiscal', authMiddleware, async (req, res) => {
  try {
    const { statusNotaFiscal } = req.body;
    const pedido = await Pedido.findById(req.params.id).populate('usuario');
    
    if (!pedido) {
      return res.status(404).json({ error: 'Pedido não encontrado' });
    }
    
    pedido.statusNotaFiscal = statusNotaFiscal;
    
    // Adicionar log
    pedido.logs = pedido.logs || [];
    pedido.logs.push({
      data: new Date(),
      usuario: req.user.username,
      acao: 'status_nota_fiscal_atualizado',
      descricao: `Status da nota fiscal alterado para: ${statusNotaFiscal}`
    });
    
    await pedido.save();
    res.json(pedido);
  } catch (error) {
    console.error('[STATUS_NOTA_FISCAL] Erro ao atualizar:', error);
    res.status(500).json({ error: 'Erro ao atualizar status da nota fiscal' });
  }
});

// Editar dados do usuário
router.put('/usuarios/:id', authMiddleware, async (req, res) => {
  try {
    console.log('[USUARIO] Iniciando edição de usuário:', req.params.id);
    console.log('[USUARIO] Dados recebidos:', req.body);
    console.log('[USUARIO] Token do usuário:', req.user);
    
    // Verificar se o ID é um ObjectId válido
    if (!req.params.id.match(/^[0-9a-fA-F]{24}$/)) {
      console.log('[USUARIO] ID inválido:', req.params.id);
      return res.status(400).json({ error: 'ID de usuário inválido' });
    }
    
    // Verificar se o usuário existe antes de tentar atualizar
    const usuarioExistente = await Usuario.findById(req.params.id);
    if (!usuarioExistente) {
      console.log('[USUARIO] Usuário não encontrado:', req.params.id);
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }
    
    console.log('[USUARIO] Usuário encontrado:', usuarioExistente.nome);
    
    // Remover campos undefined, null ou vazios dos dados de atualização
    const dadosLimpos = {};
    Object.keys(req.body).forEach(key => {
      const valor = req.body[key];
      if (valor !== undefined && valor !== null && valor !== '') {
        dadosLimpos[key] = typeof valor === 'string' ? valor.trim() : valor;
      }
    });
    
    console.log('[USUARIO] Dados limpos para atualização:', dadosLimpos);
    
    // Se não há dados para atualizar
    if (Object.keys(dadosLimpos).length === 0) {
      console.log('[USUARIO] Nenhum dado para atualizar');
      return res.json(usuarioExistente);
    }
    
    const usuario = await Usuario.findByIdAndUpdate(
      req.params.id, 
      dadosLimpos, 
      { new: true, runValidators: false } // Desabilitar validadores para evitar conflitos
    );
    
    console.log('[USUARIO] Usuário atualizado com sucesso:', usuario.nome);
    
    // Buscar pedidos do usuário para adicionar logs
    try {
      const pedidos = await Pedido.find({ usuario: req.params.id });
      console.log('[USUARIO] Encontrados', pedidos.length, 'pedidos para log');
      
      for (const pedido of pedidos) {
        try {
          pedido.logs = pedido.logs || [];
          pedido.logs.push({
            data: new Date(),
            usuario: req.user.username || req.user.nome || 'Admin',
            acao: 'dados_usuario_editados',
            descricao: `Dados do usuário ${usuario.nome} foram editados`
          });
          await pedido.save();
        } catch (logError) {
          console.warn('[USUARIO] Erro ao salvar log do pedido', pedido._id, ':', logError.message);
          // Continuar mesmo se houver erro no log de um pedido específico
        }
      }
    } catch (logError) {
      console.warn('[USUARIO] Erro ao processar logs dos pedidos:', logError.message);
      // Não falhar a atualização do usuário por causa dos logs
    }
    
    res.json(usuario);
  } catch (error) {
    console.error('[USUARIO] Erro detalhado ao editar:', error);
    console.error('[USUARIO] Stack trace:', error.stack);
    
    // Verificar se é erro de validação do Mongoose
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map(err => err.message);
      return res.status(400).json({ error: 'Erro de validação: ' + messages.join(', ') });
    }
    
    // Verificar se é erro de duplicação (email único)
    if (error.code === 11000) {
      return res.status(400).json({ error: 'Email já está em uso por outro usuário' });
    }
    
    // Verificar se é erro de Cast (ID inválido)
    if (error.name === 'CastError') {
      return res.status(400).json({ error: 'ID de usuário inválido' });
    }
    
    res.status(500).json({ error: 'Erro ao editar usuário: ' + error.message });
  }
});

// Aplicar desconto
router.put('/pedidos/:id/desconto', authMiddleware, async (req, res) => {
  try {
    const { desconto } = req.body;
    const pedido = await Pedido.findById(req.params.id).populate('usuario');
    
    if (!pedido) {
      return res.status(404).json({ error: 'Pedido não encontrado' });
    }
    
    const valorOriginal = pedido.valorTotal;
    let valorDesconto = 0;
    
    if (desconto.tipo === 'valor') {
      valorDesconto = desconto.valor;
    } else if (desconto.tipo === 'percentual') {
      valorDesconto = valorOriginal * (desconto.valor / 100);
    }
    
    pedido.desconto = desconto;
    pedido.valorDesconto = valorDesconto;
    pedido.valorTotal = valorOriginal - valorDesconto;
    
    // Adicionar log
    pedido.logs = pedido.logs || [];
    pedido.logs.push({
      data: new Date(),
      usuario: req.user.username,
      acao: 'desconto_aplicado',
      descricao: `Desconto aplicado: ${desconto.tipo === 'valor' ? `R$ ${valorDesconto.toFixed(2)}` : `${desconto.valor}%`}. Valor original: R$ ${valorOriginal.toFixed(2)}, Valor final: R$ ${pedido.valorTotal.toFixed(2)}`
    });
    
    await pedido.save();
    res.json(pedido);
  } catch (error) {
    console.error('[DESCONTO] Erro ao aplicar:', error);
    res.status(500).json({ error: 'Erro ao aplicar desconto' });
  }
});

// Editar valor final
router.put('/pedidos/:id/valor-final', authMiddleware, async (req, res) => {
  try {
    const { valorTotal } = req.body;
    const pedido = await Pedido.findById(req.params.id).populate('usuario');
    
    if (!pedido) {
      return res.status(404).json({ error: 'Pedido não encontrado' });
    }
    
    const valorAnterior = pedido.valorTotal;
    pedido.valorTotal = valorTotal;
    pedido.valorEditadoManualmente = true;
    
    // Adicionar log
    pedido.logs = pedido.logs || [];
    pedido.logs.push({
      data: new Date(),
      usuario: req.user.username,
      acao: 'valor_final_editado',
      descricao: `Valor final editado manualmente. Valor anterior: R$ ${valorAnterior.toFixed(2)}, Novo valor: R$ ${valorTotal.toFixed(2)}`
    });
    
    await pedido.save();
    res.json(pedido);
  } catch (error) {
    console.error('[VALOR_FINAL] Erro ao editar:', error);
    res.status(500).json({ error: 'Erro ao editar valor final' });
  }
});

// Edição completa do pedido (fotos, itens, valores)
router.put('/pedidos/:id/editar-completo', authMiddleware, async (req, res) => {
  try {
    const { fotos, itensAdicionais, valorUnitario, valorTotal } = req.body;
    const pedido = await Pedido.findById(req.params.id).populate('usuario');
    
    if (!pedido) {
      return res.status(404).json({ error: 'Pedido não encontrado' });
    }
    
    const dadosAnteriores = {
      fotos: pedido.fotos?.length || 0,
      itens: pedido.itensAdicionais?.length || 0,
      valorUnitario: pedido.valorUnitario,
      valorTotal: pedido.valorTotal
    };
    
    // Atualizar dados do pedido
    pedido.fotos = fotos || [];
    pedido.itensAdicionais = itensAdicionais || [];
    pedido.valorUnitario = valorUnitario || 0;
    pedido.valorTotal = valorTotal || 0;
    
    // Adicionar log detalhado
    pedido.logs = pedido.logs || [];
    const alteracoes = [];
    
    if (dadosAnteriores.fotos !== fotos.length) {
      alteracoes.push(`Fotos: ${dadosAnteriores.fotos} → ${fotos.length}`);
    }
    if (dadosAnteriores.itens !== itensAdicionais.length) {
      alteracoes.push(`Itens: ${dadosAnteriores.itens} → ${itensAdicionais.length}`);
    }
    if (dadosAnteriores.valorUnitario !== valorUnitario) {
      alteracoes.push(`Valor unitário: R$ ${dadosAnteriores.valorUnitario} → R$ ${valorUnitario}`);
    }
    if (dadosAnteriores.valorTotal !== valorTotal) {
      alteracoes.push(`Total: R$ ${dadosAnteriores.valorTotal} → R$ ${valorTotal}`);
    }
    
    pedido.logs.push({
      data: new Date(),
      usuario: req.user.username,
      acao: 'editado',
      descricao: `Pedido editado completamente: ${alteracoes.join(', ')}`
    });
    
    await pedido.save();
    
    // Recarregar com população
    const pedidoAtualizado = await Pedido.findById(pedido._id).populate('usuario');
    res.json(pedidoAtualizado);
    
  } catch (error) {
    console.error('[EDITAR_PEDIDO] Erro ao editar pedido completo:', error);
    res.status(500).json({ error: 'Erro ao editar pedido' });
  }
});

module.exports = router; 