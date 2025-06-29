const redis = require('redis');
const NodeCache = require('node-cache');
require('dotenv').config();

// Cache em memória para dados muito acessados
const memoryCache = new NodeCache({ 
  stdTTL: 300, // 5 minutos
  checkperiod: 60, // verifica a cada 1 minuto
  maxKeys: 1000 // máximo de 1000 chaves
});

// Cliente Redis
let redisClient = null;

// Inicializa conexão com Redis
async function initRedis() {
  try {
    redisClient = redis.createClient({
      url: process.env.REDIS_URL || 'redis://localhost:6379',
      socket: {
        reconnectStrategy: (retries) => {
          if (retries > 10) {
            console.error('Muitas tentativas de reconexão com Redis');
            return new Error('Falha na conexão com Redis');
          }
          return Math.min(retries * 50, 500);
        }
      }
    });

    redisClient.on('error', (err) => {
      console.error('Erro no Redis:', err);
    });

    redisClient.on('connect', () => {
      console.log('Conectado ao Redis');
    });

    await redisClient.connect();
    return true;
  } catch (error) {
    console.error('Erro ao conectar com Redis:', error);
    return false;
  }
}

// Função para obter dados do cache (Redis ou memória)
async function getFromCache(key, useMemory = false) {
  try {
    if (useMemory) {
      return memoryCache.get(key);
    }

    if (redisClient && redisClient.isReady) {
      const data = await redisClient.get(key);
      return data ? JSON.parse(data) : null;
    }
    
    // Fallback para cache em memória se Redis não estiver disponível
    return memoryCache.get(key);
  } catch (error) {
    console.error('Erro ao obter do cache:', error);
    return null;
  }
}

// Função para salvar dados no cache
async function setCache(key, data, ttl = 3600, useMemory = false) {
  try {
    if (useMemory) {
      memoryCache.set(key, data, ttl);
      return true;
    }

    if (redisClient && redisClient.isReady) {
      await redisClient.setEx(key, ttl, JSON.stringify(data));
      return true;
    }
    
    // Fallback para cache em memória
    memoryCache.set(key, data, ttl);
    return true;
  } catch (error) {
    console.error('Erro ao salvar no cache:', error);
    return false;
  }
}

// Função para invalidar cache
async function invalidateCache(pattern) {
  try {
    if (redisClient && redisClient.isReady) {
      const keys = await redisClient.keys(pattern);
      if (keys.length > 0) {
        await redisClient.del(keys);
      }
    }
    
    // Limpa cache em memória também
    memoryCache.flushAll();
    return true;
  } catch (error) {
    console.error('Erro ao invalidar cache:', error);
    return false;
  }
}

// Função para gerar chave de cache
function generateCacheKey(...parts) {
  return parts.join(':').toLowerCase().replace(/[^a-z0-9:]/g, '_');
}

// Função para verificar se cache está disponível
function isCacheAvailable() {
  return (redisClient && redisClient.isReady) || true; // sempre retorna true pois temos fallback
}

module.exports = {
  initRedis,
  getFromCache,
  setCache,
  invalidateCache,
  generateCacheKey,
  isCacheAvailable,
  memoryCache
}; 