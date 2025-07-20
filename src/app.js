const express = require('express');
const cors = require('cors');
const compression = require('compression');
const { initRedis } = require('./services/cache');
const { preCarregarDadosPopulares } = require('./services/minio');
const mongoose = require('mongoose');
require('dotenv').config();

const app = express();

// Middlewares
const corsOptions = {
  origin: function (origin, callback) {
    // Em desenvolvimento, aceita qualquer origem
    if (process.env.NODE_ENV === 'development') {
      callback(null, true);
    } else {
      const allowedOrigins = [
        'http://localhost:3000',
        'http://127.0.0.1:3000',
        'https://backend.rfsolutionbr.com.br',
        'http://127.0.0.1:3001',
        'https://site-frontend.cbltmp.easypanel.host',
        'http://site-frontend.cbltmp.easypanel.host',
        'https://foto.oballetemfoco.com',
        'https://fotos.rfsolutionbr.com.br'
      ];

      const ok = !origin || allowedOrigins.some(o => origin.startsWith(o));
      if (ok) {
        callback(null, true);
      } else {
        console.warn('[CORS] Origem não permitida:', origin);
        callback(new Error('Not allowed by CORS'));
      }
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
};

// Middleware de compressão (deve vir antes dos outros)
app.use(compression({
  filter: (req, res) => {
    // Não comprime se o request já especifica que não quer compressão
    if (req.headers['x-no-compression']) {
      return false;
    }
    // Usa filtro padrão do compression
    return compression.filter(req, res);
  },
  threshold: 1024, // Só comprime dados > 1KB
  level: 6, // Nível de compressão balanceado
}));

app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Middleware para monitoramento de performance
app.use((req, res, next) => {
  const start = Date.now();
  
  // Log específico para rotas de indexação
  if (req.path.includes('indexar-fotos')) {
    console.log(`[DEBUG] ======== REQUISIÇÃO RECEBIDA ========`);
    console.log(`[DEBUG] ${req.method} ${req.path}`);
    console.log(`[DEBUG] Headers:`, req.headers);
    console.log(`[DEBUG] Body:`, req.body);
  }
  
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`${req.method} ${req.path} - ${res.statusCode} - ${duration}ms`);
  });
  
  next();
});

// Importa rotas
const photoRoutes = require('./routes/photos');
const adminRoutes = require('./routes/admin');
const usuarioRoutes = require('./routes/usuario');
const publicRoutes = require('./routes/public'); // Importa a nova rota
app.use('/api', photoRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/usuarios', usuarioRoutes);
app.use('/api/public', publicRoutes); // Usa a nova rota

// Rota de teste
app.get('/', (req, res) => {
  res.send('API de fotos funcionando!');
});

// Rota de health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Inicialização do cache e varredura completa
async function initializeApp() {
  try {
    // Inicializa Redis
    const redisConnected = await initRedis();
    console.log(`Redis: ${redisConnected ? 'Conectado' : 'Usando cache em memória'}`);
    
    // Configurar bucket MinIO para acesso público
    const { configurarBucketPublico } = require('./services/minio');
    const bucketConfigurado = await configurarBucketPublico();
    if (bucketConfigurado) {
      console.log('✅ Bucket MinIO configurado para acesso público');
    } else {
      console.warn('⚠️ Falha ao configurar bucket MinIO - URLs assinadas serão usadas');
    }
    
    // Executa varredura completa na inicialização
    console.log('🚀 Iniciando varredura completa na inicialização...');
    setTimeout(async () => {
      try {
        await preCarregarDadosPopulares();
        console.log('✅ Varredura inicial concluída com sucesso!');
      } catch (error) {
        console.error('❌ Erro na varredura inicial:', error);
      }
    }, 5000); // Aguarda 5 segundos para o servidor inicializar completamente
    
    // Executa varredura periódica (a cada 6 horas)
    setInterval(async () => {
      console.log('🔄 Executando varredura periódica...');
      try {
        await preCarregarDadosPopulares();
        console.log('✅ Varredura periódica concluída!');
      } catch (error) {
        console.error('❌ Erro na varredura periódica:', error);
      }
    }, 6 * 60 * 60 * 1000); // 6 horas
    
  } catch (error) {
    console.error('Erro na inicialização:', error);
  }
}

// Inicializa a aplicação
initializeApp();

// Conexão com MongoDB usando variável de ambiente
const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/fotos-ballet';
mongoose.connect(mongoUri);

mongoose.connection.on('connected', () => {
  console.log('MongoDB conectado!');
});

mongoose.connection.on('error', (err) => {
  console.error('Erro ao conectar no MongoDB:', err);
});

// Importa modelos
require('./models/evento');
require('./models/usuario');
require('./models/tabelaPreco');
require('./models/pedido');
require('./models/cupom');

// Inicializa o servidor
const port = process.env.PORT || 3001;
app.listen(port, '0.0.0.0', () => {
  console.log(`🚀 Backend rodando em http://0.0.0.0:${port} (env: ${process.env.NODE_ENV})`);
});

module.exports = app;
