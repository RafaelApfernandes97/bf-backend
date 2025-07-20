const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Usuario = require('../models/usuario');
const Pedido = require('../models/pedido');
const Cupom = require('../models/cupom');
const { sendOrderSummary } = require('../services/evolutionapi');
const { gerarUrlAssinada } = require('../services/minio');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'segredo123';

function validarEmail(email) {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
}
function validarSenha(senha) {
  return typeof senha === 'string' && senha.length >= 8;
}
function validarCpfCnpj(valor) {
  // Aceita 11 (CPF) ou 14 (CNPJ) dígitos
  return /^\d{11}$/.test(valor) || /^\d{14}$/.test(valor);
}
function validarTelefone(tel) {
  // Aceita 10 ou 11 dígitos
  return /^\d{10,11}$/.test(tel.replace(/\D/g, ''));
}

// Middleware de autenticação JWT
function authMiddleware(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token não fornecido' });
  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.status(401).json({ error: 'Token inválido' });
    req.user = decoded;
    next();
  });
}

// Cadastro de usuário final
router.post('/register', async (req, res) => {
  const { email, senha, nome, cpfCnpj, telefone, cep, rua, numero, complemento, bairro, cidade, estado } = req.body;
  if (!email || !senha || !nome) {
    return res.status(400).json({ error: 'Preencha todos os campos obrigatórios.' });
  }
  if (!validarEmail(email)) {
    return res.status(400).json({ error: 'E-mail inválido.' });
  }
  if (!validarSenha(senha)) {
    return res.status(400).json({ error: 'A senha deve ter pelo menos 8 caracteres.' });
  }
  // Validação condicional para CPF/CNPJ e telefone (não obrigatórios para usuários Google)
  if (cpfCnpj && !validarCpfCnpj(cpfCnpj)) {
    return res.status(400).json({ error: 'CPF ou CNPJ inválido.' });
  }
  if (telefone && !validarTelefone(telefone)) {
    return res.status(400).json({ error: 'Telefone/WhatsApp inválido.' });
  }
  const exists = await Usuario.findOne({ email });
  if (exists) return res.status(400).json({ error: 'E-mail já cadastrado.' });
  const hash = await bcrypt.hash(senha, 10);
  const user = await Usuario.create({ email, password: hash, nome, cpfCnpj: cpfCnpj || '', telefone: telefone || '', cep, rua, numero, complemento: complemento || '', bairro, cidade, estado });
  res.json({ ok: true });
});

// Login de usuário final
router.post('/login', async (req, res) => {
  const { email, senha } = req.body;
  const user = await Usuario.findOne({ email });
  if (!user) return res.status(401).json({ error: 'E-mail ou senha inválidos.' });
  const ok = await bcrypt.compare(senha, user.password);
  if (!ok) return res.status(401).json({ error: 'E-mail ou senha inválidos.' });
  const token = jwt.sign({ id: user._id, email: user.email, nome: user.nome }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, nome: user.nome });
});

// Rota para obter dados do usuário autenticado
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const user = await Usuario.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
    res.json({
      nome: user.nome,
      email: user.email,
      cpfCnpj: user.cpfCnpj,
      telefone: user.telefone,
      cep: user.cep,
      rua: user.rua,
      numero: user.numero,
      bairro: user.bairro,
      cidade: user.cidade,
      estado: user.estado
    });
  } catch (e) {
    res.status(500).json({ error: 'Erro ao buscar dados do usuário' });
  }
});

// Rota para atualizar dados do usuário autenticado
router.put('/me', authMiddleware, async (req, res) => {
  try {
    const { nome, cpfCnpj, telefone, cep, rua, numero, complemento, bairro, cidade, estado } = req.body;
    const user = await Usuario.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
    if (nome) user.nome = nome;
    if (cpfCnpj) user.cpfCnpj = cpfCnpj;
    if (telefone) user.telefone = telefone;
    if (cep) user.cep = cep;
    if (rua) user.rua = rua;
    if (numero) user.numero = numero;
    if (complemento !== undefined) user.complemento = complemento; // Permite string vazia
    if (bairro) user.bairro = bairro;
    if (cidade) user.cidade = cidade;
    if (estado) user.estado = estado;
    await user.save();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Erro ao atualizar dados do usuário' });
  }
});

// Rota para enviar resumo do pedido via WhatsApp
router.post('/enviar-pedido-whatsapp', authMiddleware, async (req, res) => {
  console.log('[WhatsApp] Iniciando envio de pedido...');
  try {
    console.log('[WhatsApp] Body recebido:', req.body);
    const { evento, fotos, valorUnitario, cupom } = req.body; // fotos: array de objetos com nome, url, coreografia, cupom: dados do cupom aplicado
    console.log('[WhatsApp] Evento:', evento);
    console.log('[WhatsApp] Fotos:', fotos);
    console.log('[WhatsApp] Valor unitário:', valorUnitario);
    console.log('[WhatsApp] User ID:', req.user.id);
    
    const user = await Usuario.findById(req.user.id);
    console.log('[WhatsApp] Usuário encontrado:', user ? 'Sim' : 'Não');
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
    
    console.log('[WhatsApp] Dados do usuário:', {
      nome: user.nome,
      email: user.email,
      telefone: user.telefone,
      cpfCnpj: user.cpfCnpj,
      endereco: `${user.rua}, ${user.numero}${user.complemento ? `, ${user.complemento}` : ''} - ${user.bairro}, ${user.cidade} - ${user.estado}, CEP: ${user.cep}`
    });
    
    // Gerar ID único do pedido
    const pedidoId = await Pedido.gerarPedidoId();
    console.log('[WhatsApp] ID do pedido gerado:', pedidoId);
    
    // Separar itens por tipo para cálculo correto
    console.log('[WhatsApp] Debug - Analisando itens recebidos:', fotos.map(f => ({
      nome: f.nome,
      tipo: f.tipo,
      valor: f.valor,
      preco: f.preco
    })));
    
    const fotosBanner = fotos.filter(f => f.tipo === 'vale' || f.tipo === 'video' || f.tipo === 'poster');
    const fotosRegulares = fotos.filter(f => !f.tipo || (f.tipo !== 'vale' && f.tipo !== 'video' && f.tipo !== 'poster'));
    
    console.log('[WhatsApp] Banners encontrados:', fotosBanner.length);
    console.log('[WhatsApp] Fotos regulares encontradas:', fotosRegulares.length);
    
    // Calcular valor total base
    const valorFotosRegulares = fotosRegulares.length * valorUnitario;
    const valorBanners = fotosBanner.reduce((total, item) => {
      return total + (Number(item.valor) || Number(item.preco) || 0);
    }, 0);
    
    const valorBase = valorFotosRegulares + valorBanners;
    let valorTotal = valorBase;
    let cupomData = null;
    
    // Processar cupom se fornecido
    if (cupom && cupom.cupom && cupom.cupom.id) {
      console.log('[WhatsApp] Processando cupom:', cupom.cupom.codigo);
      console.log('[WhatsApp] Dados completos do cupom recebido:', JSON.stringify(cupom, null, 2));
      try {
        const cupomDoc = await Cupom.findById(cupom.cupom.id);
        if (cupomDoc) {
          console.log('[WhatsApp] Cupom encontrado no banco. Verificando se usuário já usou...');
          console.log('[WhatsApp] limitarPorUsuario:', cupomDoc.limitarPorUsuario);
          console.log('[WhatsApp] usuariosQueUsaram:', cupomDoc.usuariosQueUsaram);
          
          // Verificar novamente se usuário já usou antes de registrar
          if (cupomDoc.limitarPorUsuario && cupomDoc.usuarioJaUsou(user._id)) {
            console.log('[WhatsApp] ERRO: Usuário já usou este cupom!');
            return res.status(400).json({ 
              error: 'Este cupom já foi utilizado por você. Cada usuário pode usar este cupom apenas uma vez.' 
            });
          }
          
          // Usar o cupom (registra o uso DEFINITIVO)
          console.log('[WhatsApp] Registrando uso do cupom...');
          await cupomDoc.usarCupom(user._id, null); // pedidoId será atualizado depois
          
          // Aplicar desconto
          valorTotal = valorBase - cupom.desconto;
          cupomData = {
            codigo: cupom.cupom.codigo,
            descricao: cupom.cupom.descricao,
            desconto: cupom.desconto,
            cupomId: cupomDoc._id
          };
          console.log('[WhatsApp] Cupom aplicado com sucesso. Desconto:', cupom.desconto);
        } else {
          console.log('[WhatsApp] ERRO: Cupom não encontrado no banco');
        }
      } catch (error) {
        console.error('[WhatsApp] Erro ao processar cupom:', error.message);
        // Se erro é sobre uso já realizado, retorna erro para usuário
        if (error.message.includes('já foi utilizado')) {
          return res.status(400).json({ error: error.message });
        }
        // Para outros erros, continua sem cupom
      }
    }
    
    // Criar pedido no banco de dados
    const novoPedido = new Pedido({
      pedidoId: pedidoId,
      usuario: user._id,
      evento: evento,
      fotos: fotos,
      valorUnitario: valorUnitario,
      valorTotal: valorTotal,
      cupom: cupomData, // Inclui dados do cupom se aplicado
      status: 'pendente'
    });
    
    await novoPedido.save();
    console.log('[WhatsApp] Pedido salvo no banco de dados');
    
    // Usar variáveis já declaradas acima e criar subtipos
    const valebanner = fotosBanner.filter(f => f.tipo === 'vale');
    const videoBanner = fotosBanner.filter(f => f.tipo === 'video');
    const posterBanner = fotosBanner.filter(f => f.tipo === 'poster');
    
    // Montar mensagem com ID do pedido
    // Inserir caractere invisível após o @ para evitar link no WhatsApp
    const emailTexto = user.email.replace('@', '@\u200B');
    
    let itensDetalhados = '';
    
    // Adicionar fotos regulares
    if (fotosRegulares.length > 0) {
      itensDetalhados += `📸 Fotos (${fotosRegulares.length} itens):\n`;
      itensDetalhados += fotosRegulares.map(f => `• ${f.nome}`).join('\n');
      itensDetalhados += `\n`;
    }
    
    // Adicionar produtos (banners)
    if (fotosBanner.length > 0) {
      itensDetalhados += `${fotosRegulares.length > 0 ? '\n' : ''}🛍️ Produtos (${fotosBanner.length} itens):\n`;
      
      // Adicionar banners vale
      if (valebanner.length > 0) {
        valebanner.forEach(item => {
          const valor = Number(item.valor) || Number(item.preco) || 0;
          const codigo = item.codigo ? ` (Cód: ${item.codigo})` : '';
          itensDetalhados += `• ${item.nome}${codigo} - R$ ${valor.toFixed(2).replace('.', ',')}\n`;
        });
      }
      
      // Adicionar banners vídeo
      if (videoBanner.length > 0) {
        videoBanner.forEach(item => {
          const valor = Number(item.valor) || Number(item.preco) || 0;
          const codigo = item.codigo ? ` (Cód: ${item.codigo})` : '';
          itensDetalhados += `• ${item.nome}${codigo} - R$ ${valor.toFixed(2).replace('.', ',')}\n`;
        });
      }
      
      // Adicionar banners pôster
      if (posterBanner.length > 0) {
        posterBanner.forEach(item => {
          const valor = Number(item.valor) || Number(item.preco) || 0;
          const codigo = item.codigo ? ` (Cód: ${item.codigo})` : '';
          itensDetalhados += `• ${item.nome}${codigo} - R$ ${valor.toFixed(2).replace('.', ',')}\n`;
        });
      }
    }
    
    const mensagem = `Seu pedido foi recebido aqui no Ballet em Foco! ✨


Nº do Pedido: ${pedidoId}
Evento: ${evento}

Dados para nota fiscal:
Nome: ${user.nome}
Email: ${emailTexto}
Telefone: ${user.telefone}
CPF: ${user.cpfCnpj}
Endereço: ${user.rua}, ${user.numero}${user.complemento ? `, ${user.complemento}` : ''} - ${user.bairro}, ${user.cidade} - ${user.estado}, CEP: ${user.cep}

${itensDetalhados}
Total de Itens: ${fotos.length}${fotosRegulares.length > 0 ? `
Valor por Foto: R$ ${valorUnitario.toFixed(2).replace('.', ',')}
Subtotal Fotos: R$ ${valorFotosRegulares.toFixed(2).replace('.', ',')}` : ''}${fotosBanner.length > 0 ? `
Subtotal Produtos: R$ ${valorBanners.toFixed(2).replace('.', ',')}` : ''}${cupomData ? `

🎟️ Cupom Aplicado: ${cupomData.codigo}
Descrição: ${cupomData.descricao}
Desconto: R$ ${cupomData.desconto.toFixed(2).replace('.', ',')}
Subtotal: R$ ${valorBase.toFixed(2).replace('.', ',')}` : ''}

💰 Valor Total: R$ ${valorTotal.toFixed(2).replace('.', ',')}`;
    console.log('[WhatsApp] Mensagem montada:', mensagem);
    
    const numero = user.telefone; // O serviço evolutionapi.js adiciona o +55 automaticamente
    console.log('[WhatsApp] Número do usuário:', numero);
    
    console.log('[WhatsApp] Chamando sendOrderSummary...');
    await sendOrderSummary({ numero, mensagem });
    console.log('[WhatsApp] sendOrderSummary executado com sucesso');
    
    // Enviar segunda mensagem sobre forma de pagamento após 5 segundos
    setTimeout(async () => {
      try {
        const mensagemPagamento = 'Qual seria a melhor forma de pagamento, cartão ou pix?';
        console.log('[WhatsApp] Enviando mensagem sobre pagamento...');
        await sendOrderSummary({ numero, mensagem: mensagemPagamento });
        console.log('[WhatsApp] Mensagem sobre pagamento enviada com sucesso');
      } catch (error) {
        console.error('[WhatsApp] Erro ao enviar mensagem sobre pagamento:', error);
      }
    }, 5000);
    
    res.json({ ok: true, pedidoId: pedidoId });
  } catch (e) {
    console.error('[WhatsApp] Erro detalhado:', e);
    console.error('[WhatsApp] Stack trace:', e.stack);
    res.status(500).json({ error: 'Erro ao enviar mensagem WhatsApp: ' + e.message });
  }
});

// Rota para buscar pedidos do usuário
router.get('/meus-pedidos', authMiddleware, async (req, res) => {
  try {
    const pedidos = await Pedido.find({ usuario: req.user.id })
      .sort({ dataCriacao: -1 }) // Mais recentes primeiro
      .limit(20); // Limitar a 20 pedidos
    
    res.json({ pedidos });
  } catch (e) {
    console.error('[Pedidos] Erro ao buscar pedidos:', e);
    res.status(500).json({ error: 'Erro ao buscar pedidos' });
  }
});

// Rota para gerar URL assinada para foto do pedido
router.get('/foto-url/:evento/:coreografia/:nome', async (req, res) => {
  try {
    const { evento, coreografia, nome } = req.params;
    console.log('[Foto URL] Parâmetros recebidos:', { evento, coreografia, nome });
    
    const key = `${evento}/${coreografia}/${nome}`;
    console.log('[Foto URL] Key construída:', key);
    
    // Gerar URL assinada válida por 1 hora
    const urlAssinada = gerarUrlAssinada(key, 3600);
    console.log('[Foto URL] URL assinada gerada:', urlAssinada);
    
    res.json({ url: urlAssinada });
  } catch (e) {
    console.error('[Foto URL] Erro ao gerar URL assinada:', e);
    res.status(500).json({ error: 'Erro ao gerar URL da foto' });
  }
});

// Rota para foto URL com dia (eventos multi-dia)
router.get('/foto-url/:evento/:dia/:coreografia/:nome', async (req, res) => {
  try {
    const { evento, dia, coreografia, nome } = req.params;
    console.log('[Foto URL Dia] Parâmetros recebidos:', { evento, dia, coreografia, nome });
    
    const key = `${evento}/${dia}/${coreografia}/${nome}`;
    console.log('[Foto URL Dia] Key construída:', key);
    
    // Gerar URL assinada válida por 1 hora
    const urlAssinada = gerarUrlAssinada(key, 3600);
    console.log('[Foto URL Dia] URL assinada gerada:', urlAssinada);
    
    res.json({ url: urlAssinada });
  } catch (e) {
    console.error('[Foto URL Dia] Erro ao gerar URL assinada:', e);
    res.status(500).json({ error: 'Erro ao gerar URL da foto' });
  }
});

// Rota para foto URL com caminho completo (evento/dia/pasta/coreografia/nome)
router.get('/foto-url/:evento/:dia/:pasta/:coreografia/:nome', async (req, res) => {
  try {
    const { evento, dia, pasta, coreografia, nome } = req.params;
    console.log('[Foto URL Completa] Parâmetros recebidos:', { evento, dia, pasta, coreografia, nome });
    
    const key = `${evento}/${dia}/${pasta}/${coreografia}/${nome}`;
    console.log('[Foto URL Completa] Key construída:', key);
    
    // Gerar URL assinada válida por 1 hora
    const urlAssinada = gerarUrlAssinada(key, 3600);
    console.log('[Foto URL Completa] URL assinada gerada:', urlAssinada);
    
    res.json({ url: urlAssinada });
  } catch (e) {
    console.error('[Foto URL Completa] Erro ao gerar URL assinada:', e);
    res.status(500).json({ error: 'Erro ao gerar URL da foto' });
  }
});

// Rota para buscar detalhes de um pedido específico
router.get('/pedido/:pedidoId', authMiddleware, async (req, res) => {
  try {
    const pedido = await Pedido.findOne({ 
      pedidoId: req.params.pedidoId,
      usuario: req.user.id 
    });
    
    if (!pedido) {
      return res.status(404).json({ error: 'Pedido não encontrado' });
    }
    
    res.json({ pedido });
  } catch (e) {
    console.error('[Pedido] Erro ao buscar pedido:', e);
    res.status(500).json({ error: 'Erro ao buscar pedido' });
  }
});

module.exports = router; 