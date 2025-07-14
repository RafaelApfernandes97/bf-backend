const express = require('express');
const cors = require('cors');
const { initRedis } = require('./services/cache');
const { preCarregarDadosPopulares } = require('./services/minio');
const mongoose = require('mongoose');
require('dotenv').config();

// Otimizações para processamento massivo
if (process.env.INDEXACAO_TURBO_MODE === 'true') {
  // Aumentar limites do Node.js para modo turbo
  process.setMaxListeners(0); // Remove limite de listeners
  require('events').EventEmitter.defaultMaxListeners = 0;
  
  // Otimizar garbage collector
  if (global.gc) {
    setInterval(() => {
      global.gc();
    }, 30000); // GC a cada 30 segundos
  }
  
  console.log('🚀 MODO TURBO ATIVADO - Configurações extremas de performance');
}

const app = express();

// Middlewares
const corsOptions = {
  origin: function (origin, callback) {
    console.log(`[CORS] Verificando origem: ${origin}`);
    
    // Lista de origens permitidas
    const allowedOrigins = [
      'http://localhost:3000',
      'http://localhost:3001',
      'http://t:3000',
      'http://127.0.0.1:3000',
      'http://127.0.0.1:3001',
      'https://backend.rfsolutionbr.com.br',
      'https://site-frontend.cbltmp.easypanel.host',
      'http://site-frontend.cbltmp.easypanel.host',
      'https://foto.oballetemfoco.com',
      'https://fotos.rfsolutionbr.com.br'
    ];

    // Permitir requisições sem origem (Postman, apps móveis, etc.)
    if (!origin) {
      console.log(`[CORS] Permitindo requisição sem origem`);
      return callback(null, true);
    }

    // Em desenvolvimento, aceita localhost e 127.0.0.1
    const isDev = !process.env.NODE_ENV || process.env.NODE_ENV === 'development';
    const isLocalhost = origin.includes('localhost') || origin.includes('127.0.0.1');
    
    if (isDev && isLocalhost) {
      console.log(`[CORS] Modo desenvolvimento - permitindo origem localhost: ${origin}`);
      return callback(null, true);
    }

    // Verifica se a origem está na lista permitida
    const isAllowed = allowedOrigins.some(allowedOrigin => 
      origin === allowedOrigin || origin.startsWith(allowedOrigin)
    );
    
    if (isAllowed) {
      console.log(`[CORS] Origem permitida: ${origin}`);
      callback(null, true);
    } else {
      console.warn(`[CORS] Origem NÃO permitida: ${origin}`);
      // Em desenvolvimento, vamos permitir temporariamente para debug
      if (isDev) {
        console.log(`[CORS] Modo desenvolvimento - permitindo origem para debug: ${origin}`);
        callback(null, true);
      } else {
        callback(new Error('Não permitido pelo CORS'));
      }
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: [
    'Content-Type', 
    'Authorization', 
    'X-Requested-With',
    'Accept',
    'Origin',
    'Access-Control-Request-Method',
    'Access-Control-Request-Headers'
  ],
  exposedHeaders: ['Content-Length', 'X-Foo', 'X-Bar'],
  optionsSuccessStatus: 200, // some legacy browsers (IE11, various SmartTVs) choke on 204
  preflightContinue: false,
  maxAge: 86400 // 24 horas
};

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
require('./models/fotoIndexada');

// Inicializa o servidor
const port = process.env.PORT || 3001;
app.listen(port, '0.0.0.0', () => {
  console.log(`🚀 Backend rodando em http://0.0.0.0:${port} (env: ${process.env.NODE_ENV})`);
});

module.exports = app;
