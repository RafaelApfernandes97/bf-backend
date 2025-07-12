const express = require('express');
const router = express.Router();
const { 
  listarEventos, 
  listarCoreografias, 
  listarFotos,
  listarFotosPorCaminho,
  preCarregarDadosPopulares,
  aquecerCacheEvento,
  s3,
  bucket,
  gerarUrlAssinada,
  contarFotosRecursivo
} = require('../services/minio');

// Import bucket prefix from environment
const bucketPrefix = process.env.S3_BUCKET_PREFIX || 'balletemfoco';
const { invalidateCache, generateCacheKey } = require('../services/cache');
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
router.get('/eventos', async (req, res) => {
  try {
    const eventos = await listarEventos();
    
    // Aquece cache do primeiro evento em background
    if (eventos.length > 0) {
      setTimeout(() => {
        aquecerCacheEvento(eventos[0]);
      }, 100);
    }
    
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
    const fullPrefix = `${bucketPrefix}/${prefix}`;
    const data = await s3.listObjectsV2({
      Bucket: bucket,
      Prefix: fullPrefix,
      Delimiter: '/',
    }).promise();

    // Processar subpastas
    const subpastas = await Promise.all(
      (data.CommonPrefixes || []).map(async (p) => {
        const nome = p.Prefix.replace(fullPrefix, '').replace('/', '');
        // Contar fotos recursivamente na subpasta (remove bucket prefix for internal function)
        const relativePath = p.Prefix.replace(`${bucketPrefix}/`, '');
        const quantidade = await contarFotosRecursivo(relativePath);
        // Buscar capa
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
          quantidade,
        };
      })
    );

    // Processar fotos diretamente na pasta atual
    const region = process.env.AWS_REGION || 'us-east-1';
    const endpoint = `https://${bucket}.s3.${region}.amazonaws.com`;

    const fotos = (data.Contents || [])
      .filter(obj => !obj.Key.endsWith('/'))
      .filter(obj => obj.Key.match(/\.(jpe?g|png|gif|webp)$/i))
      .map(obj => ({
        nome: obj.Key.replace(fullPrefix, ''),
        url: `${endpoint}/${encodeURIComponent(obj.Key)}`,
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

// Rota para aquecer cache de um evento específico
router.post('/eventos/:evento/aquecer-cache', async (req, res) => {
  try {
    const { evento } = req.params;
    
    // Executa em background para não bloquear a resposta
    setTimeout(() => {
      aquecerCacheEvento(evento);
    }, 100);
    
    res.json({ message: `Cache sendo aquecido para o evento: ${evento}` });
  } catch (error) {
    console.error(`Erro detalhado ao aquecer cache para o evento ${req.params.evento}:`, error); // Log mais detalhado
    res.status(500).json({ error: 'Erro ao aquecer cache' });
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
        return res.json({ fotos: [], message: 'Nenhuma foto foi encontrada com a face da selfie enviada.' });
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
        Prefix: `${bucketPrefix}/${evento}/`,
        Delimiter: '/',
      }).promise();
      
      const prefixes = (data.CommonPrefixes || []).map(p => p.Prefix.replace(`${bucketPrefix}/${evento}/`, '').replace('/', ''));
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
        res.json({ fotos: fotosEncontradas });
      } else {
        console.log('[Buscar Selfie] Nenhuma foto correspondente encontrada nas pastas');
        res.json({ fotos: [], message: 'Faces similares foram detectadas, mas nenhuma foto correspondente foi encontrada nas pastas do evento.' });
      }
      
    } catch (rekError) {
      console.error('[Buscar Selfie] Erro no Rekognition:', rekError);
      
      if (rekError.code === 'ResourceNotFoundException') {
        console.log('[Buscar Selfie] Coleção não encontrada - retornando array vazio');
        return res.json({ fotos: [], message: 'Nenhuma foto foi encontrada para este evento.' });
      }
      
      if (rekError.code === 'InvalidParameterException') {
        console.log('[Buscar Selfie] Face não detectada na selfie - retornando array vazio');
        return res.json({ fotos: [], message: 'Nenhuma face foi detectada na selfie enviada.' });
      }
      
      console.error('[Buscar Selfie] Erro crítico no Rekognition:', rekError.code, rekError.message);
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
