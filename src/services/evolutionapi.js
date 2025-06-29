const axios = require('axios');

const EVOLUTION_API_URL = 'https://whatsapp.oballetemfoco.com/';
const INSTANCE = 'Balletemfoco_2';
const APIKEY = '4LZrB0AxrjYDyr5GwxKSOCIwIf8LI2rp';

async function sendOrderSummary({ numero, mensagem }) {
  console.log('[EvolutionAPI] Iniciando envio de mensagem...');
  console.log('[EvolutionAPI] Parâmetros recebidos:', { numero, mensagem });
  
  try {
    // Formato do número: 55DDDNÚMERO (já vem com 55 do frontend)
    // Adicionar +55 se não estiver presente
    let numeroFormatado = numero;
    if (!numero.startsWith('+55')) {
      numeroFormatado = '+55' + numero;
    }
    
    // URL correta baseada no exemplo que funciona
    const url = `${EVOLUTION_API_URL}message/sendText/${INSTANCE}`;
    console.log('[EvolutionAPI] URL da requisição:', url);
    
    // Payload correto baseado no exemplo que funciona
    const body = {
      number: numeroFormatado, // Ex: +5511999999999
      text: mensagem,
      options: {
        delay: 300,
        presence: "composing",
        linkPreview: true
      }
    };
    console.log('[EvolutionAPI] Body da requisição:', body);
    
    // Headers corretos baseados no exemplo que funciona
    const headers = {
      "Content-Type": "application/json",
      "apikey": APIKEY
    };
    console.log('[EvolutionAPI] Headers:', headers);
    
    console.log('[EvolutionAPI] Fazendo requisição POST...');
    const res = await axios.post(url, body, { headers });
    console.log('[EvolutionAPI] Resposta recebida:', res.data);
    
    return res.data;
  } catch (error) {
    console.error('[EvolutionAPI] Erro na requisição:', error.message);
    console.error('[EvolutionAPI] Status do erro:', error.response?.status);
    console.error('[EvolutionAPI] Dados do erro:', error.response?.data);
    console.error('[EvolutionAPI] Stack trace:', error.stack);
    throw error; // Re-throw para ser capturado na rota
  }
}

module.exports = { sendOrderSummary }; 