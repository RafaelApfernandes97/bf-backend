const express = require('express');
const router = express.Router();
const { 
  listarEventos, 
  listarCoreografias, 
  listarFotos,
  listarFotosPorCaminho,
  preCarregarDadosPopulares,
  analisarEstrutraEvento,
  s3,
  bucket,
  gerarUrlAssinada,
  contarFotosRecursivo
} = require('../services/minio');
const { invalidateCache, generateCacheKey } = require('../services/cache');
const { 
  cacheMiddleware, 
  invalidateCacheMiddleware, 
  warmupCacheMiddleware,
  performanceMiddleware 
} = require('../middleware/cacheMiddleware');
const rekognitionService = require('../services/rekognition');
const minioService = require('../services/minio');
const path = require('path');
const axios = require('axios');
const multer = require('multer');
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { 
    fileSize: 10 * 1024 * 1024 // 10MB limite
  }
});

// Middleware global para performance
router.use(performanceMiddleware());

// Função para normalizar nome do evento (mesmo padrão usado no admin.js)
function normalizarNomeEvento(nomeEvento) {
  return nomeEvento
    .replace(/[^a-zA-Z0-9_.\-]/g, '_') // Substitui caracteres inválidos por underscore
    .replace(/_{2,}/g, '_') // Remove underscores duplos
    .replace(/^_|_$/g, '') // Remove underscores do início e fim
    .substring(0, 100); // Limita a 100 caracteres (limite do AWS)
}

// Função para normalizar nome do arquivo (mesmo padrão usado no admin.js)
function normalizarNomeArquivo(nomeArquivo) {
  return nomeArquivo
    .replace(/[^a-zA-Z0-9_.\-:]/g, '_') // Substitui caracteres inválidos por underscore (inclui dois pontos)
    .replace(/_{2,}/g, '_') // Remove underscores duplos
    .replace(/^_|_$/g, '') // Remove underscores do início e fim
    .substring(0, 255); // Limita a 255 caracteres (limite do AWS para externalImageId)
}

// Middleware de autenticação JWT
function authMiddleware(req, res, next) {
  // Só log detalhado para a rota de busca por selfie
  const isSelfieBusca = req.path.includes('buscar-por-selfie');
  
  const token = req.headers['authorization']?.split(' ')[1];
  
  if (!token) {
    if (isSelfieBusca) console.log('[AuthMiddleware] ERRO: Token não fornecido');
    return res.status(401).json({ error: 'Token não fornecido' });
  }
  
  const jwt = require('jsonwebtoken');
  const JWT_SECRET = process.env.JWT_SECRET || 'segredo123';
  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) {
      if (isSelfieBusca) console.log('[AuthMiddleware] ERRO: Token inválido -', err.message);
      return res.status(401).json({ error: 'Token inválido' });
    }
    
    if (isSelfieBusca) console.log('[AuthMiddleware] ✅ Token válido, usuário:', decoded.nome);
    req.user = decoded;
    next();
  });
}

// Listar eventos (pastas raiz no bucket)
router.get('/eventos', 
  cacheMiddleware('eventos'), 
  warmupCacheMiddleware(preCarregarDadosPopulares),
  async (req, res) => {
    try {
      const eventos = await listarEventos();
      res.json({ eventos });
    } catch (error) {
      console.error('Erro ao listar eventos:', error);
      res.status(500).json({ error: 'Erro ao listar eventos' });
    }
  }
);

// Lista coreografias dentro de um evento
router.get('/eventos/:evento/coreografias', 
  cacheMiddleware('coreografias'),
  async (req, res) => {
    const evento = req.params.evento;

    try {
      const coreografias = await listarCoreografias(evento);
      res.json({ coreografias });
    } catch (error) {
      console.error('Erro ao listar coreografias:', error);
      res.status(500).json({ error: 'Erro ao listar coreografias' });
    }
  }
);

// Lista coreografias dentro de um dia específico de um evento
router.get('/eventos/:evento/:dia/coreografias', 
  cacheMiddleware('coreografias'),
  async (req, res) => {
    const { evento, dia } = req.params;

    try {
      const coreografias = await listarCoreografias(evento, dia);
      res.json({ coreografias });
    } catch (error) {
      console.error('Erro ao listar coreografias do dia:', error);
      res.status(500).json({ error: 'Erro ao listar coreografias do dia' });
    }
  }
);

// Lista fotos dentro de uma coreografia com paginação
router.get('/eventos/:evento/:coreografia/fotos', 
  cacheMiddleware('fotos'),
  async (req, res) => {
    const { evento, coreografia } = req.params;
    const { page = 1, limit = 50 } = req.query;

    try {
      const resultado = await listarFotos(evento, coreografia, null, parseInt(page), parseInt(limit));
      res.json(resultado);
    } catch (error) {
      console.error('Erro ao listar fotos:', error);
      res.status(500).json({ error: 'Erro ao listar fotos' });
    }
  }
);

// Lista fotos dentro de uma coreografia de um dia específico com paginação
router.get('/eventos/:evento/:dia/:coreografia/fotos', 
  cacheMiddleware('fotos'),
  async (req, res) => {
    const { evento, dia, coreografia } = req.params;
    const { page = 1, limit = 50 } = req.query;

    try {
      console.log('[Fotos Dia] Parâmetros:', { evento, dia, coreografia, page, limit });
      const resultado = await listarFotos(evento, coreografia, dia, parseInt(page), parseInt(limit));
      console.log('[Fotos Dia] Fotos encontradas:', resultado.fotos.length, 'de', resultado.pagination.total);
      res.json(resultado);
    } catch (error) {
      console.error('Erro ao listar fotos do dia:', error);
      res.status(500).json({ error: 'Erro ao listar fotos do dia' });
    }
  }
);

// Rota para navegação genérica de pastas usando POST
router.post('/eventos/pasta', async (req, res) => {
  try {
    const { caminho } = req.body;
    console.log('[PHOTOS.JS] Rota /eventos/pasta chamada com caminho:', caminho);
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
        // Contar fotos recursivamente na subpasta
        const quantidade = await contarFotosRecursivo(p.Prefix);
        // Buscar primeira foto ordenada para capa
        const objetos = await s3.listObjectsV2({
          Bucket: bucket,
          Prefix: p.Prefix,
          MaxKeys: 50 // Buscar mais para garantir ordenação correta
        }).promise();
        const fotos = objetos.Contents.filter(obj =>
          !obj.Key.endsWith('/') && /\.(jpe?g|png|webp)$/i.test(obj.Key)
        );
        
        let imagemCapa = '/img/sem_capa.jpg';
        if (fotos.length > 0) {
          // Usar a função de ordenação para garantir que a primeira foto seja correta
          const { ordenarFotosPorNumero } = require('../services/minio');
          const fotosOrdenadas = ordenarFotosPorNumero(fotos);
          imagemCapa = gerarUrlAssinada(fotosOrdenadas[0].Key, 7200);
          console.log(`[CAPA] Pasta: ${nome} - Primeira foto ordenada: ${fotosOrdenadas[0].Key}`);
        }
                  return {
            nome,
            capa: imagemCapa,
            quantidade,
          };
      })
    );

    // Processar fotos diretamente na pasta atual
    const endpoint = (process.env.MINIO_ENDPOINT || '').replace(/\/$/, '');
    if (!endpoint) {
      console.error('[FATAL] Variável de ambiente MINIO_ENDPOINT não definida!');
    }

    // Filtrar e ordenar fotos usando a mesma lógica do minio.js
    const fotosParaOrdenar = (data.Contents || [])
      .filter(obj => !obj.Key.endsWith('/'))
      .filter(obj => obj.Key.match(/\.(jpe?g|png|gif|webp)$/i));

      // Importar e usar a função de ordenação do minio.js
  const { ordenarFotosPorNumero } = require('../services/minio');
  console.log('[PASTA] 🔢 Antes da ordenação - primeiras 10 fotos:', fotosParaOrdenar.slice(0, 10).map(f => f.Key));
  const fotosOrdenadas = ordenarFotosPorNumero(fotosParaOrdenar);
  console.log('[PASTA] ✅ Após ordenação - primeiras 10 fotos:', fotosOrdenadas.slice(0, 10).map(f => f.Key));

    const fotos = fotosOrdenadas.map(obj => ({
      nome: obj.Key.replace(prefix, ''),
      url: `${endpoint}/${bucket}/${encodeURIComponent(obj.Key)}`,
    }));

    res.json({ subpastas, fotos });
  } catch (error) {
    console.error('Erro detalhado ao navegar pasta:', error); // Log mais detalhado
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

// Rota para analisar estrutura de um evento
router.get('/eventos/:evento/estrutura', async (req, res) => {
  try {
    const { evento } = req.params;
    const estrutura = await analisarEstrutraEvento(evento);
    res.json(estrutura);
  } catch (error) {
    console.error(`Erro ao analisar estrutura do evento ${req.params.evento}:`, error);
    res.status(500).json({ error: 'Erro ao analisar estrutura do evento' });
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

// Rota para estatísticas detalhadas do cache
router.get('/cache/stats', async (req, res) => {
  try {
    const { getCacheStats, isCacheAvailable } = require('../services/cache');
    const stats = getCacheStats();
    const health = isCacheAvailable();
    
    res.json({
      stats,
      health,
      timestamp: new Date().toISOString(),
      message: 'Estatísticas completas do sistema de cache'
    });
  } catch (error) {
    console.error('Erro ao obter estatísticas:', error);
    res.status(500).json({ error: 'Erro ao obter estatísticas' });
  }
});

// === ENDPOINTS OTIMIZADOS PARA BATCH REQUESTS ===

// Buscar múltiplas coreografias em paralelo
router.post('/batch/coreografias', 
  cacheMiddleware('coreografias'),
  async (req, res) => {
    try {
      const { requests } = req.body; // [{ evento, dia? }]
      
      if (!Array.isArray(requests) || requests.length === 0) {
        return res.status(400).json({ error: 'Array de requests é obrigatório' });
      }
      
      if (requests.length > 10) {
        return res.status(400).json({ error: 'Máximo 10 requests por batch' });
      }
      
      const results = await Promise.all(
        requests.map(async ({ evento, dia }) => {
          try {
            const coreografias = await listarCoreografias(evento, dia);
            return { evento, dia, coreografias, success: true };
          } catch (error) {
            return { evento, dia, error: error.message, success: false };
          }
        })
      );
      
      res.json({ results });
    } catch (error) {
      console.error('Erro no batch de coreografias:', error);
      res.status(500).json({ error: 'Erro no batch de coreografias' });
    }
  }
);

// Buscar metadados de múltiplas fotos
router.post('/batch/fotos-metadata', 
  cacheMiddleware('metadados'),
  async (req, res) => {
    try {
      const { requests } = req.body; // [{ evento, dia?, coreografia, page?, limit? }]
      
      if (!Array.isArray(requests) || requests.length === 0) {
        return res.status(400).json({ error: 'Array de requests é obrigatório' });
      }
      
      if (requests.length > 5) {
        return res.status(400).json({ error: 'Máximo 5 requests por batch para fotos' });
      }
      
      const results = await Promise.all(
        requests.map(async ({ evento, dia, coreografia, page = 1, limit = 50 }) => {
          try {
            const resultado = await listarFotos(evento, coreografia, dia, page, limit);
            return { 
              evento, 
              dia, 
              coreografia, 
              page, 
              metadata: {
                total: resultado.pagination.total,
                pages: resultado.pagination.totalPages,
                hasNext: resultado.pagination.hasNext,
                hasPrev: resultado.pagination.hasPrev,
                count: resultado.fotos.length
              }, 
              success: true 
            };
          } catch (error) {
            return { evento, dia, coreografia, error: error.message, success: false };
          }
        })
      );
      
      res.json({ results });
    } catch (error) {
      console.error('Erro no batch de metadados:', error);
      res.status(500).json({ error: 'Erro no batch de metadados' });
    }
  }
);

// Endpoint otimizado para thumbnails
router.get('/thumbnails/:evento/:coreografia', 
  cacheMiddleware('thumbnails'),
  async (req, res) => {
    try {
      const { evento, coreografia } = req.params;
      const { dia, count = 6 } = req.query; // Limita a 6 thumbnails por padrão
      
      const maxCount = Math.min(parseInt(count), 20); // Máximo 20 thumbnails
      
      const resultado = await listarFotos(evento, coreografia, dia, 1, maxCount);
      
      // Retorna apenas URLs e metadados básicos para thumbnails
      const thumbnails = resultado.fotos.map(foto => ({
        nome: foto.nome,
        url: foto.url,
        thumb: foto.url // TODO: Implementar thumbnails reais se necessário
      }));
      
      res.json({ 
        evento,
        coreografia,
        dia,
        thumbnails,
        total: resultado.pagination.total 
      });
    } catch (error) {
      console.error('Erro ao buscar thumbnails:', error);
      res.status(500).json({ error: 'Erro ao buscar thumbnails' });
    }
  }
);

// Endpoint para estrutura completa de um evento (navegação rápida)
router.get('/estrutura/:evento', 
  cacheMiddleware('metadados'),
  async (req, res) => {
    try {
      const { evento } = req.params;
      
      // Analisa estrutura do evento
      const estrutura = await analisarEstrutraEvento(evento);
      
      let navegacao = {};
      
      if (estrutura.temDias) {
        // Evento multi-dia - busca coreografias de cada dia
        navegacao = await Promise.all(
          estrutura.dias.map(async (dia) => {
            try {
              const coreografias = await listarCoreografias(evento, dia);
              return {
                dia,
                coreografias: coreografias.map(c => ({
                  nome: c.nome,
                  quantidade: c.quantidade,
                  temCapa: !!c.capa && !c.capa.includes('sem_capa')
                }))
              };
            } catch (error) {
              return { dia, error: error.message };
            }
          })
        );
      } else {
        // Evento single-dia
        const coreografias = await listarCoreografias(evento);
        navegacao = {
          tipo: 'single-dia',
          coreografias: coreografias.map(c => ({
            nome: c.nome,
            quantidade: c.quantidade,
            temCapa: !!c.capa && !c.capa.includes('sem_capa')
          }))
        };
      }
      
      res.json({
        evento,
        estrutura,
        navegacao,
        gerado: new Date().toISOString()
      });
    } catch (error) {
      console.error('Erro ao buscar estrutura:', error);
      res.status(500).json({ error: 'Erro ao buscar estrutura' });
    }
  }
);

// Buscar fotos por selfie (reconhecimento facial)
router.post('/fotos/buscar-por-selfie', (req, res, next) => {
  console.log('[Buscar Selfie] Middleware inicial - Headers:', req.headers);
  console.log('[Buscar Selfie] Middleware inicial - Content-Type:', req.get('Content-Type'));
  next();
}, authMiddleware, upload.single('selfie'), async (req, res) => {
  try {
    console.log('[Buscar Selfie] ===== INÍCIO =====');
    console.log('[Buscar Selfie] Body:', req.body);
    console.log('[Buscar Selfie] Query:', req.query);
    console.log('[Buscar Selfie] File:', req.file ? { name: req.file.originalname, size: req.file.size } : 'AUSENTE');
    console.log('[Buscar Selfie] User:', req.user ? { nome: req.user.nome } : 'AUSENTE');
    
    // Evento pode vir da query string ou do body
    const evento = req.query.evento || req.body.evento;
    
    if (!req.file) {
      console.log('[Buscar Selfie] ERRO: Arquivo não enviado');
      return res.status(400).json({ error: 'Selfie é obrigatória.' });
    }
    
    if (!evento || evento === 'undefined' || evento === 'null') {
      console.log('[Buscar Selfie] ERRO: Evento não enviado ou inválido:', evento);
      return res.status(400).json({ error: 'Evento é obrigatório e deve ser válido.' });
    }

    console.log('[Buscar Selfie] Dados válidos - Evento:', evento);
    console.log('[Buscar Selfie] Usuário:', req.user?.nome);
    console.log('[Buscar Selfie] Arquivo:', req.file.originalname, '(', req.file.size, 'bytes)');
    
    // Nome da coleção do Rekognition para o evento (usando a mesma normalização do admin.js)
    const nomeColecao = normalizarNomeEvento(evento);
    console.log('[Buscar Selfie] Coleção:', nomeColecao);
    
    try {
      // Buscar faces similares usando AWS Rekognition
      console.log('[Buscar Selfie] Iniciando busca no Rekognition...');
      console.log('[Buscar Selfie] Parâmetros:', {
        nomeColecao,
        tamanhoBuffer: req.file.buffer.length,
        maxFaces: 10,
        threshold: 70
      });
      
      const resultado = await rekognitionService.buscarFacePorImagem(
        nomeColecao,
        req.file.buffer,
        10, // máximo 10 faces
        70  // threshold de 70%
      );

      console.log('[Buscar Selfie] Resultado do Rekognition:', {
        faceMatches: resultado.FaceMatches ? resultado.FaceMatches.length : 0,
        searchedFaceBoundingBox: resultado.SearchedFaceBoundingBox ? 'presente' : 'ausente',
        searchedFaceConfidence: resultado.SearchedFaceConfidence
      });
      
      if (resultado.FaceMatches && resultado.FaceMatches.length > 0) {
        console.log('[Buscar Selfie] Primeiras faces encontradas:');
        resultado.FaceMatches.slice(0, 3).forEach((match, index) => {
          console.log(`   ${index + 1}. ExternalImageId: ${match.Face.ExternalImageId}`);
          console.log(`      Similaridade: ${match.Similarity.toFixed(2)}%`);
        });
      }
      
      if (!resultado.FaceMatches || resultado.FaceMatches.length === 0) {
        console.log('[Buscar Selfie] Nenhuma face similar encontrada');
        return res.json({ fotos: [] });
      }

      // Buscar as fotos correspondentes pelo ExternalImageId
      let fotosEncontradas = [];
      
      console.log('[Buscar Selfie] Iniciando busca das fotos correspondentes...');
      
      // Limpar cache das fotos para garantir URLs atualizadas
      const { clearAllCache } = require('../services/cache');
      await clearAllCache();
      console.log('[Buscar Selfie] Cache limpo para garantir URLs atualizadas');
      
      // Teste da função de normalização
      console.log('[Buscar Selfie] Teste de normalização:');
      const exemplosTeste = ['3425_B (110).webp', '3425_B (109).webp', '3425_B (193).webp'];
      exemplosTeste.forEach(nome => {
        const normalizado = normalizarNomeArquivo(nome);
        console.log(`[Buscar Selfie] '${nome}' => '${normalizado}'`);
      });
      
      // Buscar todas as coreografias e dias do evento
      const data = await s3.listObjectsV2({
        Bucket: bucket,
        Prefix: `${evento}/`,
        Delimiter: '/',
      }).promise();
      
      const prefixes = (data.CommonPrefixes || []).map(p => p.Prefix.replace(`${evento}/`, '').replace('/', ''));
      const dias = prefixes.filter(nome => /^\d{2}-\d{2}-/.test(nome));
      
      console.log('[Buscar Selfie] Estrutura do evento:', {
        evento,
        prefixes: prefixes.slice(0, 5), // primeiros 5
        totalPrefixes: prefixes.length,
        dias: dias.slice(0, 5), // primeiros 5
        totalDias: dias.length,
        isMultiDia: dias.length > 0
      });
      
              if (dias.length > 0) {
          // Evento multi-dia
          console.log('[Buscar Selfie] Processando evento multi-dia...');
          for (const dia of dias) {
            const coreografias = await listarCoreografias(evento, dia);
            console.log(`[Buscar Selfie] Dia ${dia}: ${coreografias.length} coreografias`);
            
            for (const coreografia of coreografias) {
              const caminho = `${evento}/${dia}/${coreografia.nome}`;
              const fotos = await listarFotosPorCaminho(caminho);
              
              console.log(`[Buscar Selfie] Caminho: ${caminho}, Fotos: ${fotos.length}`);
              
                          // Filtrar fotos que correspondem às faces encontradas
            const fotosCorrespondentes = fotos.filter(foto => {
              const nomeArquivo = path.basename(foto.nome);
              const nomeArquivoNormalizado = normalizarNomeArquivo(nomeArquivo);
              const match = resultado.FaceMatches.some(match => 
                match.Face.ExternalImageId === nomeArquivoNormalizado
              );
              
              if (match) {
                console.log(`[Buscar Selfie] ✅ MATCH ENCONTRADO: ${nomeArquivo} (normalizado: ${nomeArquivoNormalizado})`);
              }
              
              return match;
            });
              
              fotosEncontradas.push(...fotosCorrespondentes);
            }
          }
        } else {
          // Evento single-dia
          console.log('[Buscar Selfie] Processando evento single-dia...');
          const coreografias = await listarCoreografias(evento);
          console.log(`[Buscar Selfie] Evento single-dia: ${coreografias.length} coreografias`);
          
          for (const coreografia of coreografias) {
            const caminho = `${evento}/${coreografia.nome}`;
            const fotos = await listarFotosPorCaminho(caminho);
            
            console.log(`[Buscar Selfie] Caminho: ${caminho}, Fotos: ${fotos.length}`);
            
            // Log alguns exemplos de ExternalImageId vs nomes de arquivos
            if (fotos.length > 0) {
              const exemplosFotos = fotos.slice(0, 3).map(f => path.basename(f.nome));
              const exemplosExternalIds = resultado.FaceMatches.slice(0, 3).map(m => m.Face.ExternalImageId);
              
              console.log(`[Buscar Selfie] Exemplos de fotos: ${exemplosFotos.join(', ')}`);
              console.log(`[Buscar Selfie] Exemplos de ExternalImageId: ${exemplosExternalIds.join(', ')}`);
            }
            
            // Filtrar fotos que correspondem às faces encontradas
            const fotosCorrespondentes = fotos.filter(foto => {
              const nomeArquivo = path.basename(foto.nome);
              const nomeArquivoNormalizado = normalizarNomeArquivo(nomeArquivo);
              const match = resultado.FaceMatches.some(match => 
                match.Face.ExternalImageId === nomeArquivoNormalizado
              );
              
              if (match) {
                console.log(`[Buscar Selfie] ✅ MATCH ENCONTRADO: ${nomeArquivo} (normalizado: ${nomeArquivoNormalizado})`);
              }
              
              return match;
            });
            
            fotosEncontradas.push(...fotosCorrespondentes);
          }
        }

      console.log('[Buscar Selfie] ===== RESUMO FINAL =====');
      console.log(`[Buscar Selfie] Total de fotos encontradas: ${fotosEncontradas.length}`);
      console.log(`[Buscar Selfie] Faces matches do Rekognition: ${resultado.FaceMatches.length}`);
      
      if (fotosEncontradas.length > 0) {
        console.log('[Buscar Selfie] Primeiras fotos encontradas:');
        fotosEncontradas.slice(0, 3).forEach((foto, index) => {
          console.log(`   ${index + 1}. Nome: ${foto.nome}`);
          console.log(`      URL: ${foto.url}`);
          console.log(`      URL válida: ${foto.url.includes('(') ? 'PROBLEMA - Contém parênteses' : 'OK'}`);
        });
      }
      
      res.json({ fotos: fotosEncontradas });
      
    } catch (rekError) {
      console.error('[Buscar Selfie] Erro no Rekognition:', rekError);
      
      if (rekError.code === 'ResourceNotFoundException') {
        return res.status(404).json({ 
          error: `Coleção de fotos não encontrada para o evento "${evento}". Verifique se as fotos foram indexadas pelo administrador.` 
        });
      }
      
      return res.status(500).json({ 
        error: 'Erro no serviço de reconhecimento facial. Tente novamente mais tarde.' 
      });
    }
    
  } catch (error) {
    console.error('[Buscar Selfie] Erro geral:', error);
    res.status(500).json({ error: 'Erro ao buscar fotos. Tente novamente.' });
  }
});

module.exports = router;
