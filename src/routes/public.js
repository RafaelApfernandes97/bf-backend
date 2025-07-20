const express = require('express');
const Evento = require('../models/evento');
const TabelaPreco = require('../models/tabelaPreco');

const router = express.Router();

// Função para normalizar chaves do Map (remover caracteres problemáticos)
function normalizarChaveMap(chave) {
  return chave.replace(/[.]/g, '_').replace(/[^a-zA-Z0-9_]/g, '_');
}

// Função para obter chave original a partir da normalizada
function obterChaveOriginal(chaveNormalizada, diasSelecionados) {
  return diasSelecionados.find(dia => normalizarChaveMap(dia) === chaveNormalizada);
}

// Rota pública para buscar todos os eventos com detalhes de preço
router.get('/eventos', async (req, res) => {
  try {
    const eventos = await Evento.find().populate('tabelaPrecoId');
    
    // Converter capasDias de Map para objeto para serialização JSON
    const eventosProcessados = eventos.map(evento => {
      const eventoObj = evento.toObject();
      if (eventoObj.capasDias) {
        // Converter Map para objeto e mapear chaves normalizadas para originais
        const capasObj = {};
        for (const [chaveNormalizada, urlCapa] of eventoObj.capasDias) {
          const diaOriginal = obterChaveOriginal(chaveNormalizada, eventoObj.diasSelecionados);
          if (diaOriginal) {
            capasObj[diaOriginal] = urlCapa;
          }
        }
        eventoObj.capasDias = capasObj;
      }
      return eventoObj;
    });
    
    res.json(eventosProcessados);
  } catch (error) {
    console.error('Erro ao buscar eventos públicos:', error);
    res.status(500).json({ error: 'Erro ao buscar eventos' });
  }
});

// Rota pública para buscar evento por nome
router.get('/eventos/nome/:nome', async (req, res) => {
  try {
    const evento = await Evento.findOne({ nome: req.params.nome }).populate('tabelaPrecoId');
    if (!evento) {
      return res.status(404).json({ error: 'Evento não encontrado' });
    }
    
    // Converter capasDias de Map para objeto para serialização JSON
    const eventoObj = evento.toObject();
    if (eventoObj.capasDias) {
      // Converter Map para objeto e mapear chaves normalizadas para originais
      const capasObj = {};
      for (const [chaveNormalizada, urlCapa] of eventoObj.capasDias) {
        const diaOriginal = obterChaveOriginal(chaveNormalizada, eventoObj.diasSelecionados);
        if (diaOriginal) {
          // Usar URL direta do MinIO (agora com acesso público)
          capasObj[diaOriginal] = urlCapa;
        }
      }
      eventoObj.capasDias = capasObj;
    }
    
    res.json(eventoObj);
  } catch (error) {
    console.error('Erro ao buscar evento por nome:', error);
    res.status(500).json({ error: 'Erro ao buscar evento' });
  }
});

// Rota de teste para verificar configuração do MinIO
router.get('/test-minio', async (req, res) => {
  try {
    const { s3, bucket } = require('../services/minio');
    
    console.log('Teste MinIO:', {
      endpoint: process.env.MINIO_ENDPOINT,
      bucket: bucket,
      accessKey: process.env.MINIO_ACCESS_KEY ? 'Definido' : 'Não definido',
      secretKey: process.env.MINIO_SECRET_KEY ? 'Definido' : 'Não definido'
    });
    
    // Testar listagem de buckets
    const buckets = await s3.listBuckets().promise();
    
    res.json({
      success: true,
      bucket: bucket,
      buckets: buckets.Buckets.map(b => b.Name),
      config: {
        endpoint: process.env.MINIO_ENDPOINT,
        accessKey: process.env.MINIO_ACCESS_KEY ? 'Definido' : 'Não definido',
        secretKey: process.env.MINIO_SECRET_KEY ? 'Definido' : 'Não definido'
      }
    });
  } catch (error) {
    console.error('Erro no teste MinIO:', error);
    res.status(500).json({ 
      error: 'Erro no teste MinIO',
      message: error.message,
      config: {
        endpoint: process.env.MINIO_ENDPOINT,
        bucket: process.env.MINIO_BUCKET,
        accessKey: process.env.MINIO_ACCESS_KEY ? 'Definido' : 'Não definido',
        secretKey: process.env.MINIO_SECRET_KEY ? 'Definido' : 'Não definido'
      }
    });
  }
});

// Rota pública para servir capas dos eventos
router.get('/capas/:eventoId/:diaNome', async (req, res) => {
  try {
    const { eventoId, diaNome } = req.params;
    const { s3, bucket } = require('../services/minio');
    
    // Buscar o evento
    const evento = await Evento.findById(eventoId);
    if (!evento) {
      return res.status(404).json({ error: 'Evento não encontrado' });
    }
    
    // Usar chave normalizada para buscar no Map
    const chaveNormalizada = normalizarChaveMap(diaNome);
    
    // Verificar se existe capa para este dia
    if (!evento.capasDias || !evento.capasDias.has(chaveNormalizada)) {
      return res.status(404).json({ error: 'Capa não encontrada para este dia' });
    }
    
    // Obter a URL da capa do Map
    const urlCapa = evento.capasDias.get(chaveNormalizada);
    
    // Extrair a chave do MinIO da URL
    const urlParts = urlCapa.split('/');
    const key = urlParts.slice(-2).join('/'); // Pega as últimas duas partes (capas/eventoId/dia_capa.ext)
    
    console.log('Debug capa:', {
      urlCapa,
      urlParts,
      key,
      bucket,
      chaveNormalizada,
      diaOriginal: diaNome
    });
    
    // Buscar o objeto do MinIO
    const object = await s3.getObject({
      Bucket: bucket,
      Key: key
    }).promise();
    
    // Configurar headers para servir a imagem
    res.set({
      'Content-Type': object.ContentType || 'image/png',
      'Content-Length': object.ContentLength,
      'Cache-Control': 'public, max-age=3600',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD',
      'Access-Control-Allow-Headers': '*'
    });
    
    // Enviar o conteúdo da imagem
    res.send(object.Body);
    
  } catch (error) {
    console.error('Erro ao servir capa:', error);
    res.status(500).json({ error: 'Erro ao servir capa' });
  }
});

// Rota pública para buscar todas as tabelas de preço
router.get('/tabelas-preco', async (req, res) => {
  try {
    const tabelas = await TabelaPreco.find().sort({ nome: 1 });
    res.json(tabelas);
  } catch (error) {
    console.error('Erro ao buscar tabelas de preço públicas:', error);
    res.status(500).json({ error: 'Erro ao buscar tabelas de preço' });
  }
});

module.exports = router; 