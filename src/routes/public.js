const express = require('express');
const Evento = require('../models/evento');
const TabelaPreco = require('../models/tabelaPreco');

const router = express.Router();

// Rota pública para buscar todos os eventos com detalhes de preço
router.get('/eventos', async (req, res) => {
  try {
    const eventos = await Evento.find().populate('tabelaPrecoId');
    res.json(eventos);
  } catch (error) {
    console.error('Erro ao buscar eventos públicos:', error);
    res.status(500).json({ error: 'Erro ao buscar eventos' });
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