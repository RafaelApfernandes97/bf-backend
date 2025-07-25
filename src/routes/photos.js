const express = require('express');
const router = express.Router();
const { 
  listarEventos, 
  listarCoreografias, 
  listarFotos,
  preCarregarDadosPopulares,
  listarPastasEFotos
} = require('../services/minio');
const { invalidateCache, generateCacheKey } = require('../services/cache');

// Listar eventos (pastas raiz no bucket)
router.get('/eventos', async (req, res) => {
  try {
    const eventos = await listarEventos();
    res.json({ eventos });
  } catch (error) {
    console.error('Erro ao listar eventos:', error);
    res.status(500).json({ error: 'Erro ao listar eventos' });
  }
});

// Lista coreografias dentro de um evento
router.get('/eventos/:evento/coreografias', async (req, res) => {
  const evento = req.params.evento;

  try {
    const coreografias = await listarCoreografias(evento);
    res.json({ coreografias });
  } catch (error) {
    console.error('Erro ao listar coreografias:', error);
    res.status(500).json({ error: 'Erro ao listar coreografias' });
  }
});

// Lista coreografias dentro de um dia específico de um evento
router.get('/eventos/:evento/:dia/coreografias', async (req, res) => {
  const { evento, dia } = req.params;
  try {
    const coreografias = await listarCoreografias(`${evento}/${dia}`);
    res.json({ coreografias });
  } catch (error) {
    console.error('Erro ao listar coreografias do dia:', error);
    res.status(500).json({ error: 'Erro ao listar coreografias do dia' });
  }
});

// Lista fotos dentro de uma coreografia
router.get('/eventos/:evento/:coreografia/fotos', async (req, res) => {
  const { evento, coreografia } = req.params;

  try {
    const fotos = await listarFotos(evento, coreografia);
    res.json({ fotos });
  } catch (error) {
    console.error('Erro ao listar fotos:', error);
    res.status(500).json({ error: 'Erro ao listar fotos' });
  }
});

// Rota para pré-carregar dados (útil para warm-up do cache)
router.post('/pre-carregar', async (req, res) => {
  try {
    // Executa em background para não bloquear a resposta
    preCarregarDadosPopulares();
    res.json({ message: 'Pré-carregamento iniciado em background' });
  } catch (error) {
    console.error('Erro ao iniciar pré-carregamento:', error);
    res.status(500).json({ error: 'Erro ao iniciar pré-carregamento' });
  }
});

// Rota para invalidar cache (útil para atualizações)
router.delete('/cache', async (req, res) => {
  try {
    const { pattern } = req.query;
    const cachePattern = pattern || '*';
    
    await invalidateCache(cachePattern);
    res.json({ message: `Cache invalidado para o padrão: ${cachePattern}` });
  } catch (error) {
    console.error('Erro ao invalidar cache:', error);
    res.status(500).json({ error: 'Erro ao invalidar cache' });
  }
});

// Rota para estatísticas de cache (debug)
router.get('/cache/stats', async (req, res) => {
  try {
    const { memoryCache } = require('../services/cache');
    const stats = memoryCache.getStats();
    
    res.json({
      memoryCache: {
        keys: stats.keys,
        hits: stats.hits,
        misses: stats.misses,
        keyCount: stats.keyCount
      },
      message: 'Estatísticas do cache em memória'
    });
  } catch (error) {
    console.error('Erro ao obter estatísticas:', error);
    res.status(500).json({ error: 'Erro ao obter estatísticas' });
  }
});

// Rota recursiva: lista subpastas e fotos de qualquer caminho
router.get('/eventos/pasta/*', async (req, res) => {
  // O caminho após /eventos/pasta/ pode conter barras
  const caminho = req.params[0] || '';
  try {
    const resultado = await listarPastasEFotos(caminho);
    res.json(resultado);
  } catch (error) {
    console.error('Erro ao listar pastas/fotos recursivamente:', error);
    res.status(500).json({ error: 'Erro ao listar pastas/fotos' });
  }
});

module.exports = router;
