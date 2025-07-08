const express = require('express');
const router = express.Router();
const { 
  listarEventos, 
  listarCoreografias, 
  listarFotos,
  preCarregarDadosPopulares,
  s3,
  bucket,
  gerarUrlAssinada
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
    const coreografias = await listarCoreografias(evento, dia);
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

// Lista fotos dentro de uma coreografia de um dia específico
router.get('/eventos/:evento/:dia/:coreografia/fotos', async (req, res) => {
  const { evento, dia, coreografia } = req.params;

  try {
    console.log('[Fotos Dia] Parâmetros:', { evento, dia, coreografia });
    const fotos = await listarFotos(evento, coreografia, dia);
    console.log('[Fotos Dia] Fotos encontradas:', fotos.length);
    res.json({ fotos });
  } catch (error) {
    console.error('Erro ao listar fotos do dia:', error);
    res.status(500).json({ error: 'Erro ao listar fotos do dia' });
  }
});

// Rota para navegação genérica de pastas usando POST
router.post('/eventos/pasta', async (req, res) => {
  try {
    const { caminho } = req.body;
    console.log('[Pasta] Caminho recebido:', caminho);
    
    // Buscar subpastas e fotos no caminho
    const prefix = `${caminho}/`;
    const data = await s3.listObjectsV2({
      Bucket: bucket,
      Prefix: prefix,
      Delimiter: '/',
    }).promise();

    // Processar subpastas
    const subpastas = await Promise.all(
      (data.CommonPrefixes || []).map(async (p) => {
        const nome = p.Prefix.replace(prefix, '').replace('/', '');
        
        // Contar itens na subpasta para exibir quantidade
        const objetos = await s3.listObjectsV2({
          Bucket: bucket,
          Prefix: p.Prefix,
        }).promise();

        const fotos = objetos.Contents.filter(obj =>
          /\.(jpe?g|png|webp)$/i.test(obj.Key)
        );

        const imagemAleatoria = fotos.length > 0
          ? gerarUrlAssinada(fotos[Math.floor(Math.random() * fotos.length)].Key, 7200)
          : '/img/sem_capa.jpg';

        return {
          nome,
          capa: imagemAleatoria,
          quantidade: fotos.length,
        };
      })
    );

    // Processar fotos diretamente na pasta atual
    const endpoint = process.env.MINIO_ENDPOINT.replace(/\/$/, '');
    const fotos = (data.Contents || [])
      .filter(obj => !obj.Key.endsWith('/'))
      .filter(obj => obj.Key.match(/\.(jpe?g|png|gif|webp)$/i))
      .map(obj => ({
        nome: obj.Key.replace(prefix, ''),
        url: `${endpoint}/${bucket}/${encodeURIComponent(obj.Key)}`,
      }));

    res.json({ subpastas, fotos });
  } catch (error) {
    console.error('Erro ao navegar pasta:', error);
    res.status(500).json({ error: 'Erro ao navegar pasta' });
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

module.exports = router;
