const express = require('express');
const cors = require('cors');
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
      // Em produção, aceita apenas origens específicas
      const allowedOrigins = [
        'http://localhost:3000', 
        'http://127.0.0.1:3000',
        'https://site-frontend.cbltmp.easypanel.host',
        'http://site-frontend.cbltmp.easypanel.host'
      ];
      if (!origin || allowedOrigins.indexOf(origin) !== -1) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
};

app.use(cors(corsOptions));
app.use(express.json());

// Middleware para monitoramento de performance
app.use((req, res, next) => {
  const start = Date.now();
  
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
app.use('/api', photoRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/usuarios', usuarioRoutes);

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

// Inicialização do cache e pré-carregamento
async function initializeApp() {
  try {
    // Inicializa Redis
    const redisConnected = await initRedis();
    console.log(`Redis: ${redisConnected ? 'Conectado' : 'Usando cache em memória'}`);
    
    // Pré-carrega dados populares em background
    setTimeout(() => {
      preCarregarDadosPopulares();
    }, 3000); // Aguarda 3 segundos para o servidor inicializar
    
    // Executa pré-carregamento periódico (a cada 2 horas)
    setInterval(() => {
      console.log('🔄 Executando pré-carregamento periódico...');
      preCarregarDadosPopulares();
    }, 2 * 60 * 60 * 1000); // 2 horas
    
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

// Inicializa o servidor
const port = process.env.PORT || 3001;
app.listen(port, '0.0.0.0', () => {
  console.log(`🚀 Backend rodando em http://0.0.0.0:${port} (env: ${process.env.NODE_ENV})`);
});

module.exports = app;
