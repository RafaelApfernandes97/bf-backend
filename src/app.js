const express = require('express');
const cors = require('cors');
const { initRedis } = require('./services/cache');
const { preCarregarDadosPopulares } = require('./services/minio');
const mongoose = require('mongoose');
require('dotenv').config();

const app = express();

// Middlewares
app.use(cors());
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
    }, 5000); // Aguarda 5 segundos para o servidor inicializar
    
  } catch (error) {
    console.error('Erro na inicialização:', error);
  }
}

// Inicializa a aplicação
initializeApp();

mongoose.connect('mongodb://admin:admin@37.60.224.137:3060/?tls=false', {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

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

module.exports = app;
