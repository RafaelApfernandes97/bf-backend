const zlib = require('zlib');
const crypto = require('crypto');
const { getFromCache, setCache, generateCacheKey } = require('../services/cache');

// Configurações de cache por tipo de endpoint
const CACHE_CONFIGS = {
  eventos: { ttl: 3600, public: true, staleWhileRevalidate: 86400 },
  coreografias: { ttl: 1800, public: true, staleWhileRevalidate: 3600 },
  fotos: { ttl: 7200, public: true, staleWhileRevalidate: 14400 },
  metadados: { ttl: 21600, public: true, staleWhileRevalidate: 43200 },
  thumbnails: { ttl: 86400, public: true, staleWhileRevalidate: 172800 }
};

// Gera ETag baseado no conteúdo
function generateETag(data) {
  const content = typeof data === 'string' ? data : JSON.stringify(data);
  return crypto.createHash('md5').update(content).digest('hex');
}

// Comprime resposta se for grande (DESABILITADO por enquanto - usar compressão do Express)
function compressResponse(data, acceptEncoding) {
  const jsonString = typeof data === 'string' ? data : JSON.stringify(data);
  
  // Desabilita compressão manual para evitar conflitos
  // O Express compression middleware irá cuidar da compressão
  return { 
    compressed: false, 
    data: jsonString,
    originalSize: jsonString.length,
    compressedSize: jsonString.length
  };
}

// Middleware principal de cache
function cacheMiddleware(cacheType = 'default', customTTL = null) {
  return async (req, res, next) => {
    const config = CACHE_CONFIGS[cacheType] || CACHE_CONFIGS.fotos;
    const ttl = customTTL || config.ttl;
    
    // Gera chave de cache baseada na URL completa e query params
    const cacheKey = generateCacheKey(
      'http_cache',
      req.method,
      req.originalUrl,
      req.user?.id || 'anonymous',
      req.headers['accept-language'] || 'pt-BR'
    );
    
    try {
      // Verifica cache primeiro
      const cached = await getFromCache(cacheKey);
      
      if (cached) {
        // Verifica If-None-Match (ETag)
        const clientETag = req.headers['if-none-match'];
        if (clientETag && clientETag === cached.etag) {
          return res.status(304).end();
        }
        
        // Configura headers de cache
        setCacheHeaders(res, config, cached.etag, ttl);
        
                 // Retorna dados do cache (Express compression cuidará da compressão)
         return res.json(cached.data);
      }
      
      // Se não há cache, intercepta a resposta
      const originalSend = res.send;
      const originalJson = res.json;
      
      res.send = function(data) {
        saveToCache(data, cacheKey, config, req, res, ttl);
        return originalSend.call(this, data);
      };
      
      res.json = function(data) {
        saveToCache(data, cacheKey, config, req, res, ttl);
        return originalJson.call(this, data);
      };
      
      next();
      
    } catch (error) {
      console.error('Erro no middleware de cache:', error);
      next(); // Continua sem cache em caso de erro
    }
  };
}

// Configura headers HTTP de cache
function setCacheHeaders(res, config, etag, ttl) {
  const maxAge = ttl;
  const staleWhileRevalidate = config.staleWhileRevalidate;
  
  res.set({
    'Cache-Control': config.public 
      ? `public, max-age=${maxAge}, stale-while-revalidate=${staleWhileRevalidate}`
      : `private, max-age=${maxAge}`,
    'ETag': etag,
    'Vary': 'Accept-Encoding, Accept-Language, Authorization',
    'X-Cache-Status': 'HIT',
    'X-Cache-TTL': ttl.toString(),
    'Last-Modified': new Date().toUTCString()
  });
}

// Salva dados no cache
async function saveToCache(data, cacheKey, config, req, res, ttl) {
  try {
    const etag = generateETag(data);
    const compressed = compressResponse(data, req.headers['accept-encoding']);
    
    const cacheData = {
      data: data, // Dados sem compressão (Express cuidará disso)
      etag,
      originalSize: compressed.originalSize,
      timestamp: Date.now()
    };
    
    // Configura headers antes de salvar
    setCacheHeaders(res, config, etag, ttl);
    
    // Headers de performance (sem compressão manual)
    res.set('X-Response-Size', compressed.originalSize.toString());
    res.set('X-Cache-Source', 'middleware');
    
    // Salva no cache com estratégia inteligente
    const dataSize = JSON.stringify(cacheData).length;
    if (dataSize < 10240) { // < 10KB - cache rápido
      await setCache(cacheKey, cacheData, ttl, true); // memory
    } else { // >= 10KB - cache Redis
      await setCache(cacheKey, cacheData, ttl, false); // redis
    }
    
  } catch (error) {
    console.error('Erro ao salvar cache:', error);
  }
}

// Middleware específico para invalidação de cache
function invalidateCacheMiddleware(patterns = []) {
  return async (req, res, next) => {
    // Salva referência para invalidar depois
    res.invalidatePatterns = patterns;
    
    const originalSend = res.send;
    const originalJson = res.json;
    
    const invalidateCache = async () => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        const { invalidateCache: invalidate } = require('../services/cache');
        for (const pattern of patterns) {
          await invalidate(pattern);
          console.log(`🧹 Cache invalidado para padrão: ${pattern}`);
        }
      }
    };
    
    res.send = function(data) {
      invalidateCache();
      return originalSend.call(this, data);
    };
    
    res.json = function(data) {
      invalidateCache();
      return originalJson.call(this, data);
    };
    
    next();
  };
}

// Middleware para pré-aquecimento de cache
function warmupCacheMiddleware(warmupFunction) {
  return async (req, res, next) => {
    // Executa warmup em background
    setImmediate(() => {
      warmupFunction().catch(err => 
        console.error('Erro no warmup de cache:', err)
      );
    });
    
    next();
  };
}

// Middleware para estatísticas de performance
function performanceMiddleware() {
  return (req, res, next) => {
    const startTime = Date.now();
    
    const originalSend = res.send;
    const originalJson = res.json;
    
    const addPerformanceHeaders = (data) => {
      const duration = Date.now() - startTime;
      const size = Buffer.byteLength(JSON.stringify(data), 'utf8');
      
      res.set({
        'X-Response-Time': `${duration}ms`,
        'X-Response-Size': `${size} bytes`,
        'X-Cache-Timestamp': new Date().toISOString()
      });
    };
    
    res.send = function(data) {
      addPerformanceHeaders(data);
      return originalSend.call(this, data);
    };
    
    res.json = function(data) {
      addPerformanceHeaders(data);
      return originalJson.call(this, data);
    };
    
    next();
  };
}

module.exports = {
  cacheMiddleware,
  invalidateCacheMiddleware,
  warmupCacheMiddleware,
  performanceMiddleware,
  CACHE_CONFIGS
}; 