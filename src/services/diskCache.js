const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
require('dotenv').config();

// Configurações do cache em disco
const CACHE_CONFIG = {
  baseDir: process.env.DISK_CACHE_DIR || path.join(__dirname, '../../cache'),
  maxSize: parseInt(process.env.DISK_CACHE_MAX_SIZE || '1073741824'), // 1GB default
  maxFiles: parseInt(process.env.DISK_CACHE_MAX_FILES || '10000'),
  cleanupInterval: 5 * 60 * 1000, // 5 minutos
  compressionThreshold: 1024 // 1KB
};

// Estrutura para controle LRU
let cacheIndex = new Map(); // { hash: { file, size, lastAccess, created, compressed } }
let totalSize = 0;
let totalFiles = 0;

// Inicialização do cache em disco
async function initDiskCache() {
  try {
    // Cria diretórios necessários
    await fs.mkdir(CACHE_CONFIG.baseDir, { recursive: true });
    await fs.mkdir(path.join(CACHE_CONFIG.baseDir, 'images'), { recursive: true });
    await fs.mkdir(path.join(CACHE_CONFIG.baseDir, 'metadata'), { recursive: true });
    await fs.mkdir(path.join(CACHE_CONFIG.baseDir, 'thumbnails'), { recursive: true });
    
    // Carrega índice existente
    await loadCacheIndex();
    
    // Inicia limpeza periódica
    setInterval(cleanupCache, CACHE_CONFIG.cleanupInterval);
    
    console.log('✅ Cache em disco inicializado:', {
      baseDir: CACHE_CONFIG.baseDir,
      maxSize: `${(CACHE_CONFIG.maxSize / 1024 / 1024).toFixed(0)}MB`,
      maxFiles: CACHE_CONFIG.maxFiles,
      currentFiles: totalFiles,
      currentSize: `${(totalSize / 1024 / 1024).toFixed(2)}MB`
    });
    
    return true;
  } catch (error) {
    console.error('❌ Erro ao inicializar cache em disco:', error);
    return false;
  }
}

// Carrega índice do cache existente
async function loadCacheIndex() {
  try {
    const indexFile = path.join(CACHE_CONFIG.baseDir, 'index.json');
    
    try {
      const data = await fs.readFile(indexFile, 'utf8');
      const savedIndex = JSON.parse(data);
      
      // Valida arquivos existentes
      for (const [hash, entry] of Object.entries(savedIndex)) {
        const filePath = path.join(CACHE_CONFIG.baseDir, entry.file);
        try {
          const stats = await fs.stat(filePath);
          cacheIndex.set(hash, {
            ...entry,
            size: stats.size,
            lastAccess: Date.now() // Reset access time
          });
          totalSize += stats.size;
          totalFiles++;
        } catch {
          // Arquivo não existe mais, remove do índice
          console.log(`🧹 Removendo entrada órfã do índice: ${hash}`);
        }
      }
    } catch {
      // Índice não existe, inicializa vazio
      console.log('📁 Iniciando com cache em disco vazio');
    }
    
    console.log(`📊 Índice carregado: ${totalFiles} arquivos, ${(totalSize / 1024 / 1024).toFixed(2)}MB`);
  } catch (error) {
    console.error('❌ Erro ao carregar índice:', error);
  }
}

// Salva índice do cache
async function saveCacheIndex() {
  try {
    const indexFile = path.join(CACHE_CONFIG.baseDir, 'index.json');
    const indexData = Object.fromEntries(cacheIndex);
    await fs.writeFile(indexFile, JSON.stringify(indexData, null, 2));
  } catch (error) {
    console.error('❌ Erro ao salvar índice:', error);
  }
}

// Gera hash para chave de cache
function generateHash(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

// Determina subdiretório baseado no tipo de dados
function getSubDirectory(dataType) {
  if (dataType?.includes('image') || dataType?.includes('foto')) {
    return 'images';
  }
  if (dataType?.includes('thumbnail') || dataType?.includes('thumb')) {
    return 'thumbnails';
  }
  return 'metadata';
}

// Comprime dados se necessário
async function compressData(data) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(JSON.stringify(data));
  
  if (buffer.length < CACHE_CONFIG.compressionThreshold) {
    return { data: buffer, compressed: false };
  }
  
  try {
    const compressed = await new Promise((resolve, reject) => {
      zlib.gzip(buffer, (err, result) => {
        if (err) reject(err);
        else resolve(result);
      });
    });
    
    // Só comprime se realmente reduziu o tamanho
    if (compressed.length < buffer.length * 0.9) {
      return { data: compressed, compressed: true };
    }
  } catch (error) {
    console.error('Erro na compressão:', error);
  }
  
  return { data: buffer, compressed: false };
}

// Descomprime dados
async function decompressData(filePath, compressed) {
  try {
    const data = await fs.readFile(filePath);
    
    if (!compressed) {
      return data;
    }
    
    return await new Promise((resolve, reject) => {
      zlib.gunzip(data, (err, result) => {
        if (err) reject(err);
        else resolve(result);
      });
    });
  } catch (error) {
    console.error('Erro na descompressão:', error);
    throw error;
  }
}

// Salva dados no cache em disco
async function setDiskCache(key, data, ttl = 86400, dataType = 'metadata') {
  try {
    const hash = generateHash(key);
    const subDir = getSubDirectory(dataType);
    const fileName = `${hash}.cache`;
    const filePath = path.join(CACHE_CONFIG.baseDir, subDir, fileName);
    
    // Comprime dados se necessário
    const { data: processedData, compressed } = await compressData(data);
    
    // Verifica espaço disponível
    await ensureSpace(processedData.length);
    
    // Salva arquivo
    await fs.writeFile(filePath, processedData);
    
    // Atualiza índice
    const entry = {
      file: path.join(subDir, fileName),
      size: processedData.length,
      lastAccess: Date.now(),
      created: Date.now(),
      ttl: ttl * 1000, // Converte para milliseconds
      compressed,
      dataType
    };
    
    // Remove entrada antiga se existir
    if (cacheIndex.has(hash)) {
      const oldEntry = cacheIndex.get(hash);
      totalSize -= oldEntry.size;
      totalFiles--;
    }
    
    cacheIndex.set(hash, entry);
    totalSize += processedData.length;
    totalFiles++;
    
    // Salva índice periodicamente
    if (Math.random() < 0.1) { // 10% chance
      await saveCacheIndex();
    }
    
    return true;
  } catch (error) {
    console.error('❌ Erro ao salvar no cache em disco:', error);
    return false;
  }
}

// Recupera dados do cache em disco
async function getDiskCache(key) {
  try {
    const hash = generateHash(key);
    const entry = cacheIndex.get(hash);
    
    if (!entry) {
      return null;
    }
    
    // Verifica TTL
    if (Date.now() - entry.created > entry.ttl) {
      await removeCacheEntry(hash);
      return null;
    }
    
    const filePath = path.join(CACHE_CONFIG.baseDir, entry.file);
    
    // Verifica se arquivo existe
    try {
      await fs.access(filePath);
    } catch {
      // Arquivo não existe, remove do índice
      await removeCacheEntry(hash);
      return null;
    }
    
    // Atualiza último acesso
    entry.lastAccess = Date.now();
    
    // Descomprime e retorna dados
    const data = await decompressData(filePath, entry.compressed);
    
    // Tenta parsear como JSON se for metadata
    if (entry.dataType === 'metadata') {
      try {
        return JSON.parse(data.toString());
      } catch {
        return data;
      }
    }
    
    return data;
  } catch (error) {
    console.error('❌ Erro ao recuperar do cache em disco:', error);
    return null;
  }
}

// Remove entrada do cache
async function removeCacheEntry(hash) {
  try {
    const entry = cacheIndex.get(hash);
    if (!entry) return;
    
    const filePath = path.join(CACHE_CONFIG.baseDir, entry.file);
    
    try {
      await fs.unlink(filePath);
    } catch {
      // Arquivo já não existe
    }
    
    totalSize -= entry.size;
    totalFiles--;
    cacheIndex.delete(hash);
  } catch (error) {
    console.error('❌ Erro ao remover entrada do cache:', error);
  }
}

// Garante espaço suficiente no cache
async function ensureSpace(requiredSize) {
  // Verifica limites
  while (
    (totalSize + requiredSize > CACHE_CONFIG.maxSize) ||
    (totalFiles >= CACHE_CONFIG.maxFiles)
  ) {
    // Remove arquivo menos recentemente usado
    let oldestHash = null;
    let oldestAccess = Date.now();
    
    for (const [hash, entry] of cacheIndex) {
      if (entry.lastAccess < oldestAccess) {
        oldestAccess = entry.lastAccess;
        oldestHash = hash;
      }
    }
    
    if (oldestHash) {
      console.log(`🧹 Removendo cache antigo para liberar espaço: ${oldestHash}`);
      await removeCacheEntry(oldestHash);
    } else {
      break; // Não conseguiu encontrar arquivo para remover
    }
  }
}

// Limpeza periódica do cache
async function cleanupCache() {
  try {
    const now = Date.now();
    const toRemove = [];
    
    // Identifica arquivos expirados
    for (const [hash, entry] of cacheIndex) {
      if (now - entry.created > entry.ttl) {
        toRemove.push(hash);
      }
    }
    
    // Remove arquivos expirados
    if (toRemove.length > 0) {
      console.log(`🧹 Limpeza de cache: removendo ${toRemove.length} arquivos expirados`);
      
      for (const hash of toRemove) {
        await removeCacheEntry(hash);
      }
      
      await saveCacheIndex();
    }
    
    // Log estatísticas
    console.log(`📊 Cache em disco: ${totalFiles} arquivos, ${(totalSize / 1024 / 1024).toFixed(2)}MB`);
  } catch (error) {
    console.error('❌ Erro na limpeza do cache:', error);
  }
}

// Invalida cache por padrão
async function invalidateDiskCache(pattern) {
  try {
    const toRemove = [];
    
    for (const [hash, entry] of cacheIndex) {
      // Implementa invalidação por padrão simples
      if (pattern === '*' || hash.includes(pattern)) {
        toRemove.push(hash);
      }
    }
    
    if (toRemove.length > 0) {
      console.log(`🧹 Invalidando cache em disco: ${toRemove.length} entradas para padrão '${pattern}'`);
      
      for (const hash of toRemove) {
        await removeCacheEntry(hash);
      }
      
      await saveCacheIndex();
    }
    
    return toRemove.length;
  } catch (error) {
    console.error('❌ Erro ao invalidar cache em disco:', error);
    return 0;
  }
}

// Estatísticas do cache em disco
function getDiskCacheStats() {
  const stats = {
    totalFiles,
    totalSize,
    totalSizeMB: (totalSize / 1024 / 1024).toFixed(2),
    maxFiles: CACHE_CONFIG.maxFiles,
    maxSize: CACHE_CONFIG.maxSize,
    maxSizeMB: (CACHE_CONFIG.maxSize / 1024 / 1024).toFixed(0),
    utilizationFiles: ((totalFiles / CACHE_CONFIG.maxFiles) * 100).toFixed(1),
    utilizationSize: ((totalSize / CACHE_CONFIG.maxSize) * 100).toFixed(1),
    baseDir: CACHE_CONFIG.baseDir
  };
  
  // Estatísticas por tipo
  const byType = {};
  for (const [hash, entry] of cacheIndex) {
    const type = entry.dataType || 'unknown';
    if (!byType[type]) {
      byType[type] = { count: 0, size: 0 };
    }
    byType[type].count++;
    byType[type].size += entry.size;
  }
  
  stats.byType = byType;
  return stats;
}

// Limpa todo o cache em disco
async function clearDiskCache() {
  try {
    console.log('🧹 Limpando todo o cache em disco...');
    
    const toRemove = Array.from(cacheIndex.keys());
    
    for (const hash of toRemove) {
      await removeCacheEntry(hash);
    }
    
    await saveCacheIndex();
    
    console.log('✅ Cache em disco limpo completamente');
    return true;
  } catch (error) {
    console.error('❌ Erro ao limpar cache em disco:', error);
    return false;
  }
}

module.exports = {
  initDiskCache,
  setDiskCache,
  getDiskCache,
  invalidateDiskCache,
  getDiskCacheStats,
  clearDiskCache,
  cleanupCache
}; 