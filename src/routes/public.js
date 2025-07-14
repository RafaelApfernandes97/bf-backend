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
    console.log(`[DEBUG] Buscando evento por nome: ${nome}`);
    
    const evento = await Evento.findOne({ nome }).populate('tabelaPrecoId');
    
    if (!evento) {
      console.log(`[DEBUG] Evento '${nome}' não encontrado`);
      return res.status(404).json({ error: 'Evento não encontrado' });
    }
    
    console.log(`[DEBUG] Evento '${nome}' encontrado com banners: Vale=${evento.exibirBannerValeCoreografia}, Video=${evento.exibirBannerVideo}`);
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