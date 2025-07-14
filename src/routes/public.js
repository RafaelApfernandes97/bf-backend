const express = require('express');
const Evento = require('../models/evento');
const TabelaPreco = require('../models/tabelaPreco');

const router = express.Router();

// Rota pública para buscar todos os eventos com detalhes de preço
router.get('/eventos', async (req, res) => {
  try {
    console.log('[DEBUG] Requisição para /api/public/eventos recebida');
    const eventos = await Evento.find().populate('tabelaPrecoId');
    console.log(`[DEBUG] ${eventos.length} eventos encontrados`);
    res.json(eventos);
  } catch (error) {
    console.error('Erro ao buscar eventos públicos:', error);
    res.status(500).json({ error: 'Erro ao buscar eventos', detalhes: error.message });
  }
});

// Rota pública para buscar um evento específico por nome
router.get('/evento/:nome', async (req, res) => {
  try {
    const { nome } = req.params;
    const nomeDecodificado = decodeURIComponent(nome);
    console.log(`[DEBUG] Buscando evento por nome: ${nome} -> decodificado: ${nomeDecodificado}`);
    
    // Buscar por nome exato primeiro
    let evento = await Evento.findOne({ nome: nomeDecodificado }).populate('tabelaPrecoId');
    
    // Se não encontrar, tentar busca case-insensitive
    if (!evento) {
      console.log(`[DEBUG] Tentando busca case-insensitive para: ${nomeDecodificado}`);
      evento = await Evento.findOne({ 
        nome: { $regex: new RegExp(`^${nomeDecodificado}$`, 'i') } 
      }).populate('tabelaPrecoId');
    }
    
    // Se ainda não encontrar, listar todos os eventos para debug
    if (!evento) {
      const todosEventos = await Evento.find({}, 'nome');
      console.log(`[DEBUG] Evento '${nomeDecodificado}' não encontrado. Eventos disponíveis:`, 
        todosEventos.map(e => e.nome));
      return res.status(404).json({ 
        error: 'Evento não encontrado',
        eventosBuscado: nomeDecodificado,
        eventosDisponiveis: todosEventos.map(e => e.nome)
      });
    }
    
    console.log(`[DEBUG] Evento '${nomeDecodificado}' encontrado com banners: Vale=${evento.exibirBannerValeCoreografia}, Video=${evento.exibirBannerVideo}`);
    res.json(evento);
  } catch (error) {
    console.error('Erro ao buscar evento por nome:', error);
    res.status(500).json({ error: 'Erro ao buscar evento', detalhes: error.message });
  }
});

// Rota pública para buscar todas as tabelas de preço
router.get('/tabelas-preco', async (req, res) => {
  try {
    const tabelas = await TabelaPreco.find().sort({ nome: 1 });
    res.json(tabelas);
  } catch (error) {
    console.error('Erro ao buscar tabelas de preço públicas:', error);
    res.status(500).json({ error: 'Erro ao buscar tabelas de preço' });
  }
});

module.exports = router; 