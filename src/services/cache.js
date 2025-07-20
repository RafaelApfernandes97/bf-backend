const redis = require('redis');
const NodeCache = require('node-cache');
const zlib = require('zlib');
const { 
  setDiskCache, 
  getDiskCache, 
  initDiskCache, 
  invalidateDiskCache,
  getDiskCacheStats 
} = require('./diskCache');
require('dotenv').config();

// Cache em memória otimizado para dados críticos
const memoryCache = new NodeCache({ 
  stdTTL: 1800, // 30 minutos
  checkperiod: 120, // verifica a cada 2 minutos
  maxKeys: 5000, // aumentado para 5000 chaves
  useClones: false // performance boost - não clona objetos
});

// Cache secundário para dados menos críticos (TTL menor)
const fastCache = new NodeCache({
  stdTTL: 300, // 5 minutos
  checkperiod: 60, // verifica a cada 1 minuto
  maxKeys: 1000,
  useClones: false
});

// Cliente Redis com pool de conexões
let redisClient = null;

// Estatísticas de performance
const stats = {
  hits: 0,
  misses: 0,
  compressions: 0,
  decompressions: 0,
  errors: 0
};

// Inicializa conexão com Redis otimizada e cache em disco
async function initRedis() {
  try {
    // Inicializa cache em disco primeiro
    await initDiskCache();
    
    redisClient = redis.createClient({
      url: process.env.REDIS_URL || 'redis://localhost:6379',
      socket: {
        reconnectStrategy: (retries) => {
          if (retries > 20) {
            console.error('❌ Muitas tentativas de reconexão com Redis');
            return new Error('Falha crítica na conexão com Redis');
          }
          return Math.min(retries * 100, 2000); // backoff exponencial até 2s
        },
        connectTimeout: 10000, // 10s timeout
        lazyConnect: true // conexão lazy para performance
      },
      // Pool de conexões otimizado
      database: parseInt(process.env.REDIS_DB || '0'),
      retryDelayOnFailover: 100,
      maxRetriesPerRequest: 3
    });

    redisClient.on('error', (err) => {
      console.error('❌ Erro no Redis:', err.message);
      stats.errors++;
    });

    redisClient.on('connect', () => {
      console.log('✅ Redis: Conectado');
    });

    redisClient.on('ready', () => {
      console.log('✅ Redis: Pronto para uso');
    });

    redisClient.on('reconnecting', () => {
      console.log('🔄 Redis: Reconectando...');
    });

    await redisClient.connect();
    return true;
  } catch (error) {
    console.error('❌ Erro ao conectar com Redis:', error.message);
    return false;
  }
}

// Comprime dados grandes para economia de memória
function compressData(data) {
  try {
    const jsonString = JSON.stringify(data);
    if (jsonString.length > 1024) { // Só comprime dados > 1KB
      const compressed = zlib.gzipSync(jsonString);
      stats.compressions++;
      return {
        compressed: true,
        data: compressed.toString('base64')
      };
    }
    return { compressed: false, data };
  } catch (error) {
    console.error('❌ Erro ao comprimir dados:', error);
    return { compressed: false, data };
  }
}

// Descomprime dados
function decompressData(stored) {
  try {
    if (stored.compressed) {
      const buffer = Buffer.from(stored.data, 'base64');
      const decompressed = zlib.gunzipSync(buffer);
      stats.decompressions++;
      return JSON.parse(decompressed.toString());
    }
    return stored.data;
  } catch (error) {
    console.error('❌ Erro ao descomprimir dados:', error);
    return null;
  }
}

// Função inteligente para obter dados do cache (4 camadas)
async function getFromCache(key, useMemory = false, useFast = false, dataType = 'metadata') {
  try {
    // 1. Cache ultra-rápido (memória local)
    if (useFast) {
      const data = fastCache.get(key);
      if (data !== undefined) {
        stats.hits++;
        return decompressData(data);
      }
    }

    // 2. Cache em memória principal
    if (useMemory || !redisClient?.isReady) {
      const data = memoryCache.get(key);
      if (data !== undefined) {
        stats.hits++;
        return decompressData(data);
      }
    }

    // 3. Cache Redis (persistente)
    if (redisClient?.isReady && !useMemory) {
      const data = await redisClient.get(key);
      if (data) {
        const parsed = JSON.parse(data);
        stats.hits++;
        
        // Promove para cache em memória se for frequentemente acessado
        const decompressed = decompressData(parsed);
        if (decompressed && !useMemory) {
          setCache(key, decompressed, 900, true); // 15min em memória
        }
        
        return decompressed;
      }
    }

    // 4. Cache em disco (para dados grandes ou persistentes)
    const diskData = await getDiskCache(key);
    if (diskData) {
      stats.hits++;
      
      // Promove para Redis se for metadata pequena
      if (dataType === 'metadata' && JSON.stringify(diskData).length < 10240) {
        setCache(key, diskData, 3600, false); // 1h no Redis
      }
      
      return diskData;
    }
    
    stats.misses++;
    return null;
  } catch (error) {
    console.error('❌ Erro ao obter do cache:', error.message);
    stats.errors++;
    return null;
  }
}

// Função otimizada para salvar dados no cache
async function setCache(key, data, ttl = 3600, useMemory = false, useFast = false) {
  try {
    const compressed = compressData(data);
    
    // 1. Cache ultra-rápido
    if (useFast) {
      fastCache.set(key, compressed, Math.min(ttl, 300)); // máximo 5min
      return true;
    }

    // 2. Cache em memória
    if (useMemory) {
      memoryCache.set(key, compressed, ttl);
      return true;
    }

    // 3. Cache Redis
    if (redisClient?.isReady) {
      await redisClient.setEx(key, ttl, JSON.stringify(compressed));
      return true;
    }
    
    // Fallback para cache em memória
    memoryCache.set(key, compressed, ttl);
    return true;
  } catch (error) {
    console.error('❌ Erro ao salvar no cache:', error.message);
    stats.errors++;
    return false;
  }
}

// Cache inteligente que escolhe a melhor estratégia (4 camadas)
async function smartCache(key, data, ttl = 3600, strategy = 'auto', dataType = 'metadata') {
  const dataSize = JSON.stringify(data).length;
  
  switch (strategy) {
    case 'critical': // Dados críticos - todos os caches
      await setCache(key, data, Math.min(ttl, 300), false, true); // fast
      await setCache(key, data, ttl, true); // memory
      await setCache(key, data, ttl * 2, false); // redis
      await setDiskCache(key, data, ttl * 4, dataType); // disk (longo prazo)
      break;
      
    case 'frequent': // Dados frequentes - memória + redis + disco
      await setCache(key, data, ttl, true); // memory
      await setCache(key, data, ttl * 1.5, false); // redis
      await setDiskCache(key, data, ttl * 3, dataType); // disk
      break;
      
    case 'large': // Dados grandes - redis + disco
      await setCache(key, data, ttl, false); // redis
      await setDiskCache(key, data, ttl * 2, dataType); // disk (prioritário)
      break;
      
    case 'persistent': // Dados persistentes - só disco
      await setDiskCache(key, data, ttl * 5, dataType); // disk only
      break;
      
    case 'auto': // Automático baseado no tamanho
    default:
      if (dataSize < 1024) { // < 1KB - todos os caches
        await setCache(key, data, 300, false, true); // fast
        await setCache(key, data, ttl, true); // memory
        await setCache(key, data, ttl, false); // redis
      } else if (dataSize < 10240) { // < 10KB - memória + redis
        await setCache(key, data, ttl, true); // memory
        await setCache(key, data, ttl, false); // redis
        await setDiskCache(key, data, ttl * 2, dataType); // disk
      } else if (dataSize < 102400) { // < 100KB - redis + disco
        await setCache(key, data, ttl, false); // redis
        await setDiskCache(key, data, ttl * 2, dataType); // disk
      } else { // > 100KB - só disco
        await setDiskCache(key, data, ttl * 2, dataType); // disk only
      }
      break;
  }
  
  return true;
}

// Invalidação inteligente com padrões (4 camadas)
async function invalidateCache(pattern) {
  try {
    let removedCount = 0;
    
    // Limpa cache em memória
    if (pattern === '*') {
      memoryCache.flushAll();
      fastCache.flushAll();
      removedCount += memoryCache.keys().length + fastCache.keys().length;
    } else {
      // Busca e remove chaves que correspondem ao padrão
      const memKeys = memoryCache.keys().filter(key => 
        key.includes(pattern.replace('*', ''))
      );
      memKeys.forEach(key => {
        memoryCache.del(key);
        fastCache.del(key);
      });
      removedCount += memKeys.length;
    }
    
    // Limpa Redis
    if (redisClient?.isReady) {
      if (pattern === '*') {
        await redisClient.flushDb();
      } else {
        const keys = await redisClient.keys(pattern);
        if (keys.length > 0) {
          await redisClient.del(keys);
          removedCount += keys.length;
        }
      }
    }
    
    // Limpa cache em disco
    const diskRemoved = await invalidateDiskCache(pattern);
    removedCount += diskRemoved;
    
    console.log(`🧹 Cache invalidado para padrão: ${pattern} (${removedCount} entradas removidas)`);
    return true;
  } catch (error) {
    console.error('❌ Erro ao invalidar cache:', error.message);
    stats.errors++;
    return false;
  }
}

// Função para gerar chave de cache otimizada
function generateCacheKey(...parts) {
  return parts
    .filter(part => part !== null && part !== undefined && part !== '')
    .join(':')
    .toLowerCase()
    .replace(/[^a-z0-9:_-]/g, '_')
    .substring(0, 200); // Limita tamanho da chave
}

// Limpa completamente todos os caches
async function clearAllCache() {
  try {
    console.log('🧹 Limpando todos os caches...');
    
    // Limpa caches em memória
    memoryCache.flushAll();
    fastCache.flushAll();
    console.log('✅ Cache em memória limpo');
    
    // Limpa Redis
    if (redisClient?.isReady) {
      await redisClient.flushDb();
      console.log('✅ Cache Redis limpo');
    }
    
    // Reset estatísticas
    stats.hits = 0;
    stats.misses = 0;
    stats.compressions = 0;
    stats.decompressions = 0;
    stats.errors = 0;
    
    return true;
  } catch (error) {
    console.error('❌ Erro ao limpar cache:', error.message);
    return false;
  }
}

// Warm-up do cache com dados críticos
async function warmupCache() {
  try {
    console.log('🔥 Iniciando warm-up do cache...');
    
    // Aqui você pode pré-carregar dados críticos
    // Exemplo: eventos mais acessados, coreografias populares, etc.
    
    console.log('✅ Warm-up do cache concluído');
    return true;
  } catch (error) {
    console.error('❌ Erro no warm-up do cache:', error.message);
    return false;
  }
}

// Estatísticas detalhadas do cache (4 camadas)
function getCacheStats() {
  const memStats = memoryCache.getStats();
  const fastStats = fastCache.getStats();
  const diskStats = getDiskCacheStats();
  
  return {
    memory: {
      keys: memStats.keys,
      hits: memStats.hits,
      misses: memStats.misses,
      keyCount: memStats.keyCount,
      vsize: memStats.vsize,
      ksize: memStats.ksize
    },
    fast: {
      keys: fastStats.keys,
      hits: fastStats.hits,
      misses: fastStats.misses,
      keyCount: fastStats.keyCount
    },
    disk: diskStats,
    global: {
      ...stats,
      hitRate: ((stats.hits / (stats.hits + stats.misses)) * 100).toFixed(2) + '%'
    },
    redis: {
      connected: redisClient?.isReady || false
    },
    summary: {
      totalCacheEntries: memStats.keyCount + fastStats.keyCount + diskStats.totalFiles,
      totalCacheSize: `${((memStats.vsize || 0) / 1024 / 1024).toFixed(2)}MB (mem) + ${diskStats.totalSizeMB}MB (disk)`,
      hitRate: ((stats.hits / (stats.hits + stats.misses)) * 100).toFixed(2) + '%'
    }
  };
}

// Verifica saúde do cache
function isCacheAvailable() {
  return {
    memory: memoryCache !== null,
    fast: fastCache !== null,
    redis: redisClient?.isReady || false,
    overall: true // sempre true pois temos fallbacks
  };
}

// Otimização periódica do cache
function optimizeCache() {
  try {
    // Remove dados antigos e otimiza memória
    memoryCache.prune();
    fastCache.prune();
    
    console.log('🔧 Cache otimizado');
    return true;
  } catch (error) {
    console.error('❌ Erro ao otimizar cache:', error.message);
    return false;
  }
}

// Auto-otimização a cada 5 minutos
setInterval(optimizeCache, 5 * 60 * 1000);

module.exports = {
  initRedis,
  getFromCache,
  setCache,
  smartCache,
  invalidateCache,
  clearAllCache,
  generateCacheKey,
  isCacheAvailable,
  getCacheStats,
  warmupCache,
  optimizeCache,
  memoryCache,
  fastCache
}; 