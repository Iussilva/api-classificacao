require('dotenv').config();

// ── Valida que .env obrigatório está presente ────────────────
const REQUIRED_ENV = ['FB_HOST', 'FB_DATABASE', 'FB_USER', 'FB_PASSWORD', 'JWT_SECRET', 'ADMIN_USER', 'ADMIN_PASS_HASH', 'ALLOWED_ORIGIN'];
REQUIRED_ENV.forEach(function (k) {
  if (!process.env[k]) {
    console.error('[ERRO FATAL] Variável de ambiente ausente: ' + k);
    process.exit(1);
  }
});

const express = require('express');
const Firebird = require('node-firebird');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const path = require('path');

const app = express();

// ── Headers de segurança HTTP ────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],

      scriptSrc: [
        "'self'",
        "'unsafe-inline'",
        "https://cdnjs.cloudflare.com"
      ],

      scriptSrcAttr: ["'unsafe-inline'"],

      styleSrc: [
        "'self'",
        "'unsafe-inline'",
        "https://fonts.googleapis.com",
        "https://cdn-uicons.flaticon.com"
      ],

      fontSrc: [
        "'self'",
        "https://fonts.gstatic.com",
        "https://cdn-uicons.flaticon.com",
        "data:"
      ],

      imgSrc: [
        "'self'",
        "data:",
        "https:"
      ],

      connectSrc: ["'self'"]
    }
  },
  crossOriginEmbedderPolicy: false
}));

// ── CORS restrito ao domínio configurado no .env ─────────────
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN,   // obrigatório no .env — sem fallback
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Token']
}));

app.use(express.json());

// ── Rate limiting geral (M1) ─────────────────────────────────
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 200,
  message: { erro: 'Muitas requisições. Tente novamente em 15 minutos.' }
});
app.use('/api/', limiter);

// ── Rate limiting ESTRITO para login ────────────────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { erro: 'Muitas tentativas de login. Tente novamente em 15 minutos.' },
  skipSuccessfulRequests: true,  // não conta logins bem-sucedidos
});
app.use('/api/auth/login', loginLimiter);

// ── Arquivos estáticos do front-end ─────────────────────────
const publicPath = path.join(__dirname, 'public');

app.use('/css', express.static(path.join(publicPath, 'css')));
app.use('/js', express.static(path.join(publicPath, 'js')));
app.use('/img', express.static(path.join(publicPath, 'img')));
app.use('/assets', express.static(path.join(publicPath, 'assets')));
app.use('/fonts', express.static(path.join(publicPath, 'fonts')));

app.use(express.static(publicPath));

app.get('/', function (req, res) {
  res.sendFile(path.join(publicPath, 'index.html'));
});

// ════════════════════════════════════════════════════════════
// MIDDLEWARE DE AUTENTICAÇÃO — JWT obrigatório em /api/
// ════════════════════════════════════════════════════════════
function autenticar(req, res, next) {
  // Rotas públicas
  if (req.path === '/api/ping' || req.path === '/api/auth/login') {
    return next();
  }

  // Tudo que não for /api não passa por JWT
  if (!req.path.startsWith('/api/')) {
    return next();
  }

  // JWT via header Authorization: Bearer <token>
  var authHeader = req.headers['authorization'] || '';
  var token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ erro: 'Token de autenticação ausente.' });
  }

  try {
    var decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.usuario = decoded.usuario;
    next();
  } catch (e) {
    return res.status(401).json({ erro: 'Token inválido ou expirado. Faça login novamente.' });
  }
}

app.use(autenticar);

// ════════════════════════════════════════════════════════════════
// CONFIGURAÇÃO DO BANCO FIREBIRD
// ════════════════════════════════════════════════════════════════

const fbOptions = {
  host: process.env.FB_HOST || 'localhost',
  port: parseInt(process.env.FB_PORT) || 3050,
  database: process.env.FB_DATABASE || 'C:\\Conttroller\\Dados\\gerais.fdb',
  user: process.env.FB_USER || 'SYSDBA',
  password: process.env.FB_PASSWORD || 'masterkey',
  charset: process.env.FB_CHARSET || 'ISO8859_1',
  lowercase_keys: false,
};

// ── Função de query reutilizável ─────────────────────────────
function query(sql, params) {
  params = params || [];
  return new Promise(function (resolve, reject) {
    Firebird.attach(fbOptions, function (err, db) {
      if (err) return reject(err);
      db.query(sql, params, function (err, result) {
        db.detach();
        if (err) return reject(err);
        resolve(result);
      });
    });
  });
}

// ════════════════════════════════════════════════════════════════
// SISTEMA DE CACHE EM MEMÓRIA
// TTL padrão: 5 minutos — configurável via CACHE_TTL_MS no .env
// ════════════════════════════════════════════════════════════════

var cacheStore = {};
var CACHE_TTL = parseInt(process.env.CACHE_TTL_MS) || 5 * 60 * 1000;

async function comCache(chave, fn) {
  var agora = Date.now();
  var item = cacheStore[chave];
  if (item && (agora - item.ts) < CACHE_TTL) {
    console.log('[Cache] HIT → ' + chave);
    return item.data;
  }
  console.log('[Cache] MISS → ' + chave);
  var data = await fn();
  cacheStore[chave] = { ts: agora, data: data };
  return data;
}

function limparCache() {
  cacheStore = {};
  console.log('[Cache] Limpo manualmente.');
}

setInterval(function () {
  var agora = Date.now();
  var antes = Object.keys(cacheStore).length;
  Object.keys(cacheStore).forEach(function (k) {
    if ((agora - cacheStore[k].ts) >= CACHE_TTL) delete cacheStore[k];
  });
  var depois = Object.keys(cacheStore).length;
  if (antes !== depois) console.log('[Cache] Limpeza: ' + (antes - depois) + ' entradas removidas.');
}, 10 * 60 * 1000);

app.post('/api/cache/limpar', function (req, res) {
  limparCache();
  res.json({ ok: true, mensagem: 'Cache limpo com sucesso.' });
});

app.get('/api/cache/status', function (req, res) {
  var agora = Date.now();
  var entradas = Object.keys(cacheStore).map(function (k) {
    return { chave: k, idade_segundos: Math.round((agora - cacheStore[k].ts) / 1000) };
  });
  res.json({ total: entradas.length, ttl_ms: CACHE_TTL, entradas: entradas });
});

// ════════════════════════════════════════════════════════════════
// FABRICANTES FIXOS — apenas estes são consultados
// Altere esta lista para adicionar/remover fabricantes
// ════════════════════════════════════════════════════════════════

var FABRICANTES_FIXOS = [
  'SG METAIS LTDA',
  'MANTOVANI JOIAS LTDA.',
  'ELLOS GOLD INDUSTRIA E COMERCIO LTDA'
];

// Monta cláusula IN com os fabricantes fixos (sem parâmetros — nomes fixos)
var FABRICANTES_IN = FABRICANTES_FIXOS.map(function (n) {
  return "'" + n.replace(/'/g, "''") + "'";
}).join(', ');

/**
 * Monta filtro SQL para fabricante e loja a partir dos query params.
 * Garante que TODOS os endpoints usem a mesma lógica.
 *
 * @param {object} req - request Express
 * @returns {{ lojaFiltro, fabFiltro, cacheKey }} strings SQL e chave de cache
 */
function montarFiltrosSP(req) {
  var interno_est = req.query.interno_est ? parseInt(req.query.interno_est) : null;
  var fabParam = req.query.fabricante || null;
  var teor = req.query.teor || null;

  // Filtro de loja
  var lojaFiltro = interno_est ? ' AND PE.INTERNO_EST = ' + interno_est : '';

  // Filtro de fabricante — aceita INTERNO numérico ou nome
  var fabFiltro = '';
  if (fabParam) {
    if (!isNaN(fabParam)) {
      fabFiltro = ' AND CF.INTERNO = ' + parseInt(fabParam);
    } else {
      fabFiltro = " AND TRIM(CF.NOME) = '" + fabParam.replace(/'/g, "''") + "'";
    }
  }

  // Filtro de teor (busca no nome do produto)
  var teorFiltro = teor
    ? " AND UPPER(P.NOME) CONTAINING UPPER('" + teor.replace(/'/g, "''") + "')"
    : '';

  var cacheKey = (interno_est || 'T') + ':' + (fabParam || 'T') + ':' + (teor || 'T');

  return { lojaFiltro: lojaFiltro, fabFiltro: fabFiltro, teorFiltro: teorFiltro, cacheKey: cacheKey };
}

/**
 * Retorna a data de hoje no formato MM/DD/YYYY (exigido pela SP_POSICAO_ESTOQUE_MOD3)
 */
function dataHoje() {
  var hoje = new Date();
  return String(hoje.getMonth() + 1).padStart(2, '0') + '/' +
    String(hoje.getDate()).padStart(2, '0') + '/' +
    hoje.getFullYear();
}

// ════════════════════════════════════════════════════════════════
// ENDPOINTS
// ════════════════════════════════════════════════════════════════

// ── PING ─────────────────────────────────────────────────────
app.get('/api/ping', async function (req, res) {
  try {
    await query('SELECT 1 FROM RDB$DATABASE', []);
    res.json({ status: 'ok', servico: 'Classificacao', hora: new Date().toLocaleTimeString('pt-BR') });
  } catch (err) {
    // Não expõe detalhes internos do banco para o cliente
    console.error('[Ping] Erro de conexão com o banco:', err.message);
    res.status(500).json({ status: 'erro', mensagem: 'Erro ao conectar com o banco de dados.' });
  }
});

// ── ESTABELECIMENTOS ──────────────────────────────────────────
app.get('/api/estabelecimentos', async function (req, res) {
  try {
    var rows = await query(
      'SELECT INTERNO,' +
      '  TRIM(NOME) AS NOME,' +
      '  COALESCE(TRIM(FANTASIA), TRIM(NOME)) AS FANTASIA' +
      ' FROM ESTABELECIMENTO' +
      ' WHERE INTERNO > 0' +
      ' ORDER BY INTERNO',
      []
    );
    res.json({ estabelecimentos: rows });
  } catch (err) { res.status(500).json({ erro: 'Erro interno no servidor.' });; }
});

// ── FABRICANTES ───────────────────────────────────────────────
// Retorna apenas os fabricantes fixos configurados nesta API
app.get('/api/fabricantes', async function (req, res) {
  try {
    var sql =
      'SELECT DISTINCT CF.INTERNO, TRIM(CF.NOME) AS NOME' +
      ' FROM CLIENTE_FORNECEDOR CF' +
      ' WHERE TRIM(CF.NOME) IN (' + FABRICANTES_IN + ')' +
      ' ORDER BY CF.NOME';
    var rows = await query(sql, []);
    res.json({ fabricantes: rows });
  } catch (err) { res.status(500).json({ erro: 'Erro interno no servidor.' });; }
});

// ── ESTOQUE — VITRINE ─────────────────────────────────────────
// Retorna saldo da vitrine (tipo 2) dos fabricantes fixos
// Loja obrigatória para performance
app.get('/api/estoque', async function (req, res) {
  try {
    // Loja obrigatória APENAS quando nenhum fabricante específico está selecionado
    // Com fabricante selecionado, pode consultar todas as lojas
    if (!req.query.interno_est && !req.query.fabricante) {
      return res.status(400).json({
        erro: 'Selecione uma loja ou um fabricante para consultar.',
        codigo: 'FILTRO_OBRIGATORIO'
      });
    }

    var interno_est = req.query.interno_est ? parseInt(req.query.interno_est) : null;
    var dataRef = dataHoje();

    // Filtro opcional por fabricante — aceita INTERNO (número) ou NOME (texto)
    var fabParam = req.query.fabricante || null;
    var fabFiltro = '';
    if (fabParam) {
      if (!isNaN(fabParam)) {
        // Recebeu o código numérico (INTERNO) — filtro por ID
        fabFiltro = ' AND CF.INTERNO = ' + parseInt(fabParam);
      } else {
        // Recebeu nome — filtro por nome exato
        fabFiltro = " AND TRIM(CF.NOME) = '" + fabParam.replace(/'/g, "''") + "'";
      }
    }

    // Filtro opcional por teor (ex: 10K, 18K)
    var f = montarFiltrosSP(req);
    var dataRef = dataHoje();

    var sql =
      'SELECT' +
      '  P.CODIGO,' +
      '  TRIM(P.NOME) AS NOME,' +
      '  TRIM(CF.NOME) AS FABRICANTE,' +
      '  PE.INTERNO_EST AS ESTABELECIMENTO,' +
      '  COALESCE(TRIM(EST.FANTASIA), TRIM(EST.NOME)) AS NOME_ESTABELECIMENTO,' +
      '  COALESCE(POS.SALDO_FINAL_PROPRIO, 0) AS SALDO' +
      ' FROM PRODUTO_ESTABELECIMENTO PE' +
      ' INNER JOIN PRODUTO P ON P.INTERNO = PE.INTERNO_PRODUTO' +
      ' INNER JOIN CLIENTE_FORNECEDOR CF ON CF.INTERNO = P.INTERNO_FABRICANTE' +
      ' LEFT JOIN ESTABELECIMENTO EST ON EST.INTERNO = PE.INTERNO_EST' +
      ' LEFT JOIN SP_POSICAO_ESTOQUE_MOD3(' +
      '   2, PE.INTERNO, NULL,' +
      "   '" + dataRef + "', '" + dataRef + "', 'Não'" +
      ' ) POS ON 0 = 0' +
      " WHERE P.ATIVO = 'Ativo'" +
      " AND P.TIPO = 'Produto'" +
      ' AND TRIM(CF.NOME) IN (' + FABRICANTES_IN + ')' +
      f.fabFiltro + f.lojaFiltro + f.teorFiltro +
      ' AND COALESCE(POS.SALDO_FINAL_PROPRIO, 0) <> 0' +
      ' ORDER BY CF.NOME, P.NOME';

    var cacheKey = 'estoque:' + f.cacheKey;
    var todos = await comCache(cacheKey, async function () { return await query(sql, []); });
    var pagina = parseInt(req.query.pagina) || 1;
    var limite = parseInt(req.query.limite) || 9999;
    var total_itens = todos.length;
    var total_saldo = todos.reduce(function (s, r) { return s + (parseFloat(r.SALDO) || 0); }, 0);
    var inicio = (pagina - 1) * limite;
    var rows = todos.slice(inicio, inicio + limite);

    res.json({
      estoque: rows,
      pagina: pagina,
      paginas: Math.ceil(total_itens / limite),
      limite: limite,
      total_itens: total_itens,
      total_saldo: total_saldo,
      data_ref: dataRef,
    });
  } catch (err) { res.status(500).json({ erro: 'Erro interno no servidor.' });; }
});

// ── RESUMO POR FABRICANTE ─────────────────────────────────────
// Agrupa saldo total por fabricante (apenas os 3 fixos)
app.get('/api/estoque/por-fabricante', async function (req, res) {
  try {
    var f = montarFiltrosSP(req);
    var dataRef = dataHoje();

    var sql =
      'SELECT' +
      '  CF.INTERNO AS INTERNO_FABRICANTE,' +
      '  TRIM(CF.NOME) AS FABRICANTE,' +
      '  COUNT(DISTINCT P.INTERNO) AS QTD_PRODUTOS,' +
      '  SUM(COALESCE(POS.SALDO_FINAL_PROPRIO, 0)) AS SALDO_TOTAL' +
      ' FROM PRODUTO_ESTABELECIMENTO PE' +
      ' INNER JOIN PRODUTO P ON P.INTERNO = PE.INTERNO_PRODUTO' +
      ' INNER JOIN CLIENTE_FORNECEDOR CF ON CF.INTERNO = P.INTERNO_FABRICANTE' +
      ' LEFT JOIN SP_POSICAO_ESTOQUE_MOD3(' +
      '   2, PE.INTERNO, NULL,' +
      "   '" + dataRef + "', '" + dataRef + "', 'Não'" +
      ' ) POS ON 0 = 0' +
      " WHERE P.ATIVO = 'Ativo'" +
      " AND P.TIPO = 'Produto'" +
      ' AND TRIM(CF.NOME) IN (' + FABRICANTES_IN + ')' +
      f.fabFiltro +
      f.lojaFiltro +
      f.teorFiltro +
      ' AND COALESCE(POS.SALDO_FINAL_PROPRIO, 0) <> 0' +
      ' GROUP BY CF.INTERNO, CF.NOME' +
      ' ORDER BY SALDO_TOTAL DESC';

    var cacheKey = 'fab:' + f.cacheKey;
    var rows = await comCache(cacheKey, async function () { return await query(sql, []); });
    var total = rows.reduce(function (s, r) { return s + (parseFloat(r.SALDO_TOTAL) || 0); }, 0);

    res.json({ fabricantes: rows, total_saldo: total, data_ref: dataRef });
  } catch (err) { res.status(500).json({ erro: 'Erro interno no servidor.' });; }
});

// ── RESUMO POR LOJA ───────────────────────────────────────────
// Agrupa saldo total por estabelecimento (apenas os 3 fabricantes fixos)
app.get('/api/estoque/por-loja', async function (req, res) {
  try {
    var f = montarFiltrosSP(req);
    var dataRef = dataHoje();

    var sql =
      'SELECT' +
      '  PE.INTERNO_EST AS ESTABELECIMENTO,' +
      '  COALESCE(TRIM(EST.FANTASIA), TRIM(EST.NOME)) AS NOME_LOJA,' +
      '  COUNT(DISTINCT P.INTERNO) AS QTD_PRODUTOS,' +
      '  SUM(COALESCE(POS.SALDO_FINAL_PROPRIO, 0)) AS SALDO_TOTAL' +
      ' FROM PRODUTO_ESTABELECIMENTO PE' +
      ' INNER JOIN PRODUTO P ON P.INTERNO = PE.INTERNO_PRODUTO' +
      ' INNER JOIN CLIENTE_FORNECEDOR CF ON CF.INTERNO = P.INTERNO_FABRICANTE' +
      ' LEFT JOIN ESTABELECIMENTO EST ON EST.INTERNO = PE.INTERNO_EST' +
      ' LEFT JOIN SP_POSICAO_ESTOQUE_MOD3(' +
      '   2, PE.INTERNO, NULL,' +
      "   '" + dataRef + "', '" + dataRef + "', 'Não'" +
      ' ) POS ON 0 = 0' +
      " WHERE P.ATIVO = 'Ativo'" +
      " AND P.TIPO = 'Produto'" +
      ' AND TRIM(CF.NOME) IN (' + FABRICANTES_IN + ')' +
      f.fabFiltro +
      f.lojaFiltro +
      f.teorFiltro +
      ' AND COALESCE(POS.SALDO_FINAL_PROPRIO, 0) <> 0' +
      ' GROUP BY PE.INTERNO_EST, EST.FANTASIA, EST.NOME' +
      ' ORDER BY SALDO_TOTAL DESC';

    var cacheKey = 'loja:' + f.cacheKey;
    var rows = await comCache(cacheKey, async function () { return await query(sql, []); });
    var total = rows.reduce(function (s, r) { return s + (parseFloat(r.SALDO_TOTAL) || 0); }, 0);

    res.json({ lojas: rows, total_saldo: total, data_ref: dataRef });
  } catch (err) { res.status(500).json({ erro: 'Erro interno no servidor.' });; }
});

// ── FABRICANTE × LOJA (cruzamento) ───────────────────────────
app.get('/api/estoque/fabricante-por-loja', async function (req, res) {
  try {
    var interno_est = req.query.interno_est ? parseInt(req.query.interno_est) : null;
    var dataRef = dataHoje();

    var lojaFiltro = interno_est ? ' AND PE.INTERNO_EST = ' + interno_est : '';

    var sql =
      'SELECT' +
      '  CF.INTERNO AS INTERNO_FABRICANTE,' +
      '  TRIM(CF.NOME) AS FABRICANTE,' +
      '  PE.INTERNO_EST AS ESTABELECIMENTO,' +
      '  COALESCE(TRIM(EST.FANTASIA), TRIM(EST.NOME)) AS NOME_LOJA,' +
      '  COUNT(DISTINCT P.INTERNO) AS QTD_PRODUTOS,' +
      '  SUM(COALESCE(POS.SALDO_FINAL_PROPRIO, 0)) AS SALDO_TOTAL' +
      ' FROM PRODUTO_ESTABELECIMENTO PE' +
      ' INNER JOIN PRODUTO P ON P.INTERNO = PE.INTERNO_PRODUTO' +
      ' INNER JOIN CLIENTE_FORNECEDOR CF ON CF.INTERNO = P.INTERNO_FABRICANTE' +
      ' LEFT JOIN ESTABELECIMENTO EST ON EST.INTERNO = PE.INTERNO_EST' +
      ' LEFT JOIN SP_POSICAO_ESTOQUE_MOD3(' +
      '   2, PE.INTERNO, NULL,' +
      "   '" + dataRef + "', '" + dataRef + "', 'Não'" +
      ' ) POS ON 0 = 0' +
      " WHERE P.ATIVO = 'Ativo'" +
      " AND P.TIPO = 'Produto'" +
      ' AND TRIM(CF.NOME) IN (' + FABRICANTES_IN + ')' +
      lojaFiltro +
      ' AND COALESCE(POS.SALDO_FINAL_PROPRIO, 0) <> 0' +
      ' GROUP BY CF.INTERNO, CF.NOME, PE.INTERNO_EST, EST.FANTASIA, EST.NOME' +
      ' ORDER BY CF.NOME, SALDO_TOTAL DESC';

    var rows = await query(sql, []);
    res.json({ dados: rows, data_ref: dataRef });
  } catch (err) { res.status(500).json({ erro: 'Erro interno no servidor.' });; }
});

// ── RANKING DOS 3 FABRICANTES ────────────────────────────────
app.get('/api/estoque/ranking', async function (req, res) {
  try {
    var f = montarFiltrosSP(req);
    var dataRef = dataHoje();

    var sql =
      'SELECT' +
      '  CF.INTERNO,' +
      '  TRIM(CF.NOME) AS FABRICANTE,' +
      '  COUNT(DISTINCT P.INTERNO) AS QTD_PRODUTOS,' +
      '  COUNT(DISTINCT PE.INTERNO_EST) AS QTD_LOJAS,' +
      '  SUM(COALESCE(POS.SALDO_FINAL_PROPRIO, 0)) AS SALDO_TOTAL' +
      ' FROM PRODUTO_ESTABELECIMENTO PE' +
      ' INNER JOIN PRODUTO P ON P.INTERNO = PE.INTERNO_PRODUTO' +
      ' INNER JOIN CLIENTE_FORNECEDOR CF ON CF.INTERNO = P.INTERNO_FABRICANTE' +
      ' LEFT JOIN SP_POSICAO_ESTOQUE_MOD3(' +
      '   2, PE.INTERNO, NULL,' +
      "   '" + dataRef + "', '" + dataRef + "', 'Não'" +
      ' ) POS ON 0 = 0' +
      " WHERE P.ATIVO = 'Ativo'" +
      " AND P.TIPO = 'Produto'" +
      ' AND TRIM(CF.NOME) IN (' + FABRICANTES_IN + ')' +
      f.fabFiltro +
      f.lojaFiltro +
      f.teorFiltro +
      ' AND COALESCE(POS.SALDO_FINAL_PROPRIO, 0) <> 0' +
      ' GROUP BY CF.INTERNO, CF.NOME' +
      ' ORDER BY SALDO_TOTAL DESC';

    var cacheKey = 'rank:' + f.cacheKey;
    var rows = await comCache(cacheKey, async function () { return await query(sql, []); });
    var total = rows.reduce(function (s, r) { return s + (parseFloat(r.SALDO_TOTAL) || 0); }, 0);

    res.json({ ranking: rows, total_geral: total, data_ref: dataRef });
  } catch (err) { res.status(500).json({ erro: 'Erro interno no servidor.' });; }
});

// ════════════════════════════════════════════════════════════════
// MAPA DE COORDENADORES — internos das lojas por responsável
// ════════════════════════════════════════════════════════════════

var COORDENADORES = {
  'Bruno': [5, 8, 9, 17, 18],          // Natal, João Pessoa, Fortaleza, Recife, Maceió
  'Gabriel': [12, 19, 20, 4, 3, 15],      // São Luís/Tropical, São Luís/Centro, São Luís/Cohab, Imperatriz, Marabá, Belém
  'Raiane': [23, 1, 6, 10, 25, 16, 13]   // FSA/Getúlio, Barra, Itaigara, Aracaju, Goiânia, Feira de Santana, Avenida Sete
};
// Nota: ajuste os INTERNOs acima se algum não bater com o banco.
// Referência da imagem fornecida:
//  1=Barra, 2=CT Produção, 3=Marabá, 4=Imperatriz, 5=Natal, 6=Itaigara
//  8=João Pessoa, 9=Fortaleza, 10=Aracaju, 13=São Luís/Tropical, 15=Belém
//  16=FSA, 17=Maceió, 18=Recife, 19=São Luís/Centro, 20=São Luís/Cohab
//  23=FSA/Getúlio, 25=Goiânia, 28=Vila Conceição, 30=Vila Mariana

// Endpoint: retorna o mapa de coordenadores
app.get('/api/coordenadores', function (req, res) {
  res.json({ coordenadores: COORDENADORES });
});

// ════════════════════════════════════════════════════════════════
// ENDPOINT: VENDAS — Histórico de notas de saída por período
// GET /api/vendas
// Query params:
//   data_inicio  — YYYY-MM-DD  (obrigatório)
//   data_fim     — YYYY-MM-DD  (obrigatório)
//   interno_est  — número      (opcional — filtra por loja)
//   fabricante   — nome/interno (opcional)
//   coordenador  — Bruno|Gabriel|Raiane (opcional)
// ════════════════════════════════════════════════════════════════

app.get('/api/vendas', async function (req, res) {
  try {
    var dataInicio = req.query.data_inicio;
    var dataFim = req.query.data_fim;

    if (!dataInicio || !dataFim) {
      return res.status(400).json({ erro: 'Parâmetros data_inicio e data_fim são obrigatórios (YYYY-MM-DD).' });
    }

    // Converte YYYY-MM-DD → MM/DD/YYYY (formato Firebird)
    function fmtFB(d) {
      var p = d.split('-');
      return p[1] + '/' + p[2] + '/' + p[0];
    }
    var di = fmtFB(dataInicio);
    var df = fmtFB(dataFim);

    // Filtro de loja — pode vir de interno_est ou de coordenador
    var lojaFiltro = '';
    var coordenador = req.query.coordenador || null;
    var interno_est = req.query.interno_est ? parseInt(req.query.interno_est) : null;

    if (coordenador && COORDENADORES[coordenador]) {
      var ids = COORDENADORES[coordenador].join(', ');
      lojaFiltro = ' AND e.INTERNO IN (' + ids + ')';
    } else if (interno_est) {
      lojaFiltro = ' AND e.INTERNO = ' + interno_est;
    }

    // Filtro de fabricante
    var fabParam = req.query.fabricante || null;
    var fabFiltro = '';
    if (fabParam) {
      if (!isNaN(fabParam)) {
        fabFiltro = ' AND cf_forn.INTERNO = ' + parseInt(fabParam);
      } else {
        fabFiltro = " AND TRIM(cf_forn.NOME) = '" + fabParam.replace(/'/g, "''") + "'";
      }
    } else {
      // Padrão: apenas os fabricantes fixos
      fabFiltro = ' AND TRIM(cf_forn.NOME) IN (' + FABRICANTES_IN + ')';
    }

    var sql =
      'SELECT' +
      '  cdn.NOTA_NUMERO,' +
      '  cdn.TOTAL_PRODUTOS_DESC,' +
      '  cdn.DATA_EMISSAO,' +
      '  TRIM(cf_cliente.NOME) AS CLIENTE,' +
      '  TRIM(cf_forn.NOME)    AS FABRICANTE,' +
      '  e.INTERNO             AS COD_LOJA,' +
      '  TRIM(e.NOME)          AS ESTABELECIMENTO,' +
      '  TRIM(mdn.NOME)        AS MODELO,' +
      '  l.QUANTIDADE,' +
      '  TRIM(p.NOME)          AS PRODUTO' +
      ' FROM CABECALHO_DE_NOTA cdn' +
      ' JOIN CLIENTE_FORNECEDOR cf_cliente ON cf_cliente.INTERNO = cdn.INTERNO_CLIENTE' +
      ' JOIN ESTABELECIMENTO e             ON e.INTERNO = cdn.INTERNO_EST' +
      ' JOIN MODELO_DE_NOTA mdn            ON mdn.INTERNO = cdn.INTERNO_MODELO' +
      ' JOIN LANCAMENTO l                  ON l.INTERNO_CABECALHO = cdn.INTERNO' +
      ' JOIN PRODUTO_ESTABELECIMENTO pe    ON pe.INTERNO = l.INTERNO_PRODUTO_EST' +
      ' JOIN PRODUTO p                     ON p.INTERNO = pe.INTERNO_PRODUTO' +
      ' LEFT JOIN CLIENTE_FORNECEDOR cf_forn ON cf_forn.INTERNO = p.INTERNO_FABRICANTE' +
      " WHERE cdn.CANCELADO = 'Não'" +
      ' AND cdn.INTERNO_LOCAL = 2' +
      ' AND mdn.INTERNO IN (25, 26)' +
      " AND cdn.DATA_EMISSAO >= CAST('" + di + "' AS DATE)" +
      " AND cdn.DATA_EMISSAO <= CAST('" + df + "' AS DATE)" +
      lojaFiltro +
      fabFiltro +
      ' ORDER BY cdn.DATA_EMISSAO DESC';

    var cacheKey = 'vendas:' + dataInicio + ':' + dataFim + ':' + (interno_est || coordenador || 'T') + ':' + (fabParam || 'T');

    var rows = await comCache(cacheKey, async function () {
      return await query(sql, []);
    });

    // ── Agregações server-side ────────────────────────────────

    // Top produtos por quantidade
    var prodQtd = {};
    var prodFab = {};
    rows.forEach(function (r) {
      var k = r.PRODUTO || '—';
      var q = parseFloat(r.QUANTIDADE) || 0;
      prodQtd[k] = (prodQtd[k] || 0) + q;
      prodFab[k] = r.FABRICANTE || '—';
    });

    var topProdutos = Object.entries(prodQtd)
      .map(function (e) { return { produto: e[0], quantidade: e[1], fabricante: prodFab[e[0]] }; })
      .sort(function (a, b) { return b.quantidade - a.quantidade; })
      .slice(0, 20);

    // Total por fabricante
    var fabTotais = {};
    rows.forEach(function (r) {
      var f = r.FABRICANTE || '—';
      fabTotais[f] = (fabTotais[f] || 0) + (parseFloat(r.QUANTIDADE) || 0);
    });
    var porFabricante = Object.entries(fabTotais)
      .map(function (e) { return { fabricante: e[0], quantidade: e[1] }; })
      .sort(function (a, b) { return b.quantidade - a.quantidade; });

    // Total por loja
    var lojaTotais = {};
    var lojaNomes = {};
    rows.forEach(function (r) {
      var cod = r.COD_LOJA;
      lojaTotais[cod] = (lojaTotais[cod] || 0) + (parseFloat(r.QUANTIDADE) || 0);
      lojaNomes[cod] = r.ESTABELECIMENTO || 'Loja ' + cod;
    });
    var porLoja = Object.entries(lojaTotais)
      .map(function (e) { return { cod_loja: parseInt(e[0]), nome_loja: lojaNomes[e[0]], quantidade: e[1] }; })
      .sort(function (a, b) { return b.quantidade - a.quantidade; });

    res.json({
      vendas: rows,
      total_itens: rows.length,
      top_produtos: topProdutos,
      por_fabricante: porFabricante,
      por_loja: porLoja,
      data_inicio: dataInicio,
      data_fim: dataFim,
    });

  } catch (err) { res.status(500).json({ erro: 'Erro interno no servidor.' });; }
});

// ════════════════════════════════════════════════════════════════
// MÓDULO: INTELIGÊNCIA ARTIFICIAL — Groq (llama-3.3-70b)
// Funcionalidades:
//  1. Chat flutuante — conversa livre sobre o sistema
//  2. Resumo automático — interpreta dados do estoque ao consultar
//  3. Análise de estoque por linguagem natural
//  4. Análise de contratos de compra
// ════════════════════════════════════════════════════════════════

var OpenAI = require('openai');

var openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || '',
  baseURL: 'https://api.groq.com/openai/v1',
});

// Contexto base do sistema — enviado em todas as conversas
var SYSTEM_PROMPT = [
  'Você é um assistente de inteligência de negócios da Ourobras Joias.',
  'Tem acesso a dados de estoque da vitrine (tipo 2) dos fabricantes:',
  '  • ELLOS GOLD INDUSTRIA E COMERCIO LTDA',
  '  • SG METAIS LTDA',
  '  • MANTOVANI JOIAS LTDA.',
  'Os valores de estoque são em GRAMAS (g).',
  'Responda sempre em português brasileiro, de forma objetiva e profissional.',
  'Quando analisar dados, destaque insights importantes como:',
  '  - Fabricante/loja com maior ou menor estoque',
  '  - Produtos com estoque baixo',
  '  - Distribuição por família de produto',
  '  - Tendências ou anomalias nos dados',
  'Seja direto e use bullet points quando listar informações.',
].join('\n');

/**
 * Chama a API OpenAI com histórico de mensagens.
 * @param {Array} messages - Array de { role, content }
 * @param {number} maxTokens - Limite de tokens na resposta
 */
async function chamarOpenAI(messages, maxTokens) {
  // Verifica se a chave foi configurada
  var key = process.env.OPENAI_API_KEY || '';
  if (!key || key === 'sk-coloque-sua-chave-aqui' || key.length < 20) {
    throw new Error('OPENAI_KEY_MISSING');
  }
  maxTokens = maxTokens || 800;
  var response = await openai.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [{ role: 'system', content: SYSTEM_PROMPT }].concat(messages),
    max_tokens: maxTokens,
    temperature: 0.7,
  });
  return response.choices[0].message.content;
}

// ── 1. CHAT FLUTUANTE ─────────────────────────────────────────
// Busca dados REAIS do banco e inclui como contexto para a IA
// POST /api/ia/chat
// Body: { mensagens: [{ role, content }], filtros: { interno_est, fabricante } }
app.post('/api/ia/chat', async function (req, res) {
  try {
    var mensagens = req.body.mensagens || [];
    var filtros = req.body.filtros || {};
    if (!mensagens.length) {
      return res.status(400).json({ erro: 'Nenhuma mensagem enviada.' });
    }

    // ── Busca dados reais do Firebird ─────────────────────────
    var dataRef = dataHoje();
    var f = montarFiltrosSP({ query: filtros });

    // Query resumida por fabricante × loja
    var sqlResumo =
      'SELECT' +
      '  TRIM(CF.NOME) AS FABRICANTE,' +
      '  COALESCE(TRIM(EST.FANTASIA), TRIM(EST.NOME)) AS LOJA,' +
      '  PE.INTERNO_EST AS COD_LOJA,' +
      '  COUNT(DISTINCT P.INTERNO) AS QTD_PRODUTOS,' +
      '  SUM(COALESCE(POS.SALDO_FINAL_PROPRIO, 0)) AS SALDO_TOTAL' +
      ' FROM PRODUTO_ESTABELECIMENTO PE' +
      ' INNER JOIN PRODUTO P ON P.INTERNO = PE.INTERNO_PRODUTO' +
      ' INNER JOIN CLIENTE_FORNECEDOR CF ON CF.INTERNO = P.INTERNO_FABRICANTE' +
      ' LEFT JOIN ESTABELECIMENTO EST ON EST.INTERNO = PE.INTERNO_EST' +
      ' LEFT JOIN SP_POSICAO_ESTOQUE_MOD3(' +
      '   2, PE.INTERNO, NULL,' +
      "   '" + dataRef + "', '" + dataRef + "', 'Não'" +
      ' ) POS ON 0 = 0' +
      " WHERE P.ATIVO = 'Ativo'" +
      " AND P.TIPO = 'Produto'" +
      ' AND TRIM(CF.NOME) IN (' + FABRICANTES_IN + ')' +
      f.fabFiltro + f.lojaFiltro +
      ' AND COALESCE(POS.SALDO_FINAL_PROPRIO, 0) <> 0' +
      ' GROUP BY CF.NOME, EST.FANTASIA, EST.NOME, PE.INTERNO_EST' +
      ' ORDER BY CF.NOME, SALDO_TOTAL DESC';

    var cacheKey = 'chat_ctx:' + dataRef + ':' + (filtros.interno_est || 'T') + ':' + (filtros.fabricante || 'T');
    var dadosReais = await comCache(cacheKey, async function () {
      return await query(sqlResumo, []);
    });

    // ── Monta contexto com dados reais ────────────────────────
    var totalGeral = dadosReais.reduce(function (s, r) { return s + (parseFloat(r.SALDO_TOTAL) || 0); }, 0);

    // Agrupa por fabricante
    var porFab = {};
    var porLoja = {};
    dadosReais.forEach(function (r) {
      var fab = (r.FABRICANTE || '—').trim();
      var loja = (r.LOJA || 'Loja ' + r.COD_LOJA).trim();
      var s = parseFloat(r.SALDO_TOTAL) || 0;
      if (!porFab[fab]) porFab[fab] = { saldo: 0, lojas: [] };
      if (!porLoja[loja]) porLoja[loja] = { saldo: 0, fabricantes: [] };
      porFab[fab].saldo += s;
      porFab[fab].lojas.push(loja + ': ' + s.toFixed(3) + 'g');
      porLoja[loja].saldo += s;
      porLoja[loja].fabricantes.push(fab + ': ' + s.toFixed(3) + 'g');
    });

    var linhasFab = Object.entries(porFab)
      .sort(function (a, b) { return b[1].saldo - a[1].saldo; })
      .map(function (e) {
        return '\u2022 ' + e[0] + ': ' + e[1].saldo.toFixed(3) + 'g | ' + e[1].lojas.join(' | ');
      }).join('\n');

    var linhasLoja = Object.entries(porLoja)
      .sort(function (a, b) { return b[1].saldo - a[1].saldo; })
      .map(function (e) {
        return '• ' + e[0] + ': ' + e[1].saldo.toFixed(3) + 'g (' + e[1].fabricantes.join(' | ') + ')';
      }).join('\n');

    var contexto = [
      '=== ESTOQUE REAL — ' + dataRef + ' ===',
      'Total geral: ' + totalGeral.toFixed(3) + 'g',
      'Fabricantes: ELLOS GOLD | SG METAIS | MANTOVANI JOIAS',
      '',
      '--- POR FABRICANTE ---',
      linhasFab || 'Sem dados',
      '',
      '--- POR LOJA ---',
      linhasLoja || 'Sem dados',
      '',
      'IMPORTANTE: Use APENAS esses dados reais. NAO invente valores.',
    ].join('\n');

    // Injeta contexto como primeira mensagem do sistema
    var mensagensComContexto = [
      { role: 'user', content: contexto },
      { role: 'assistant', content: 'Entendido. Tenho os dados reais do estoque da Ourobras. Pode perguntar!' }
    ].concat(mensagens);

    var resposta = await chamarOpenAI(mensagensComContexto, 800);
    res.json({ resposta: resposta });

  } catch (err) {
    if (err.message === 'OPENAI_KEY_MISSING') {
      return res.status(200).json({
        resposta: '⚠️ Chave não configurada. Adicione OPENAI_API_KEY no .env com sua chave do Groq (gsk_...)'
      });
    }
    res.status(500).json({ erro: 'Erro interno no servidor.' });;
  }
});
// ── 2. RESUMO AUTOMÁTICO DO ESTOQUE ──────────────────────────
// Recebe os dados já consultados e gera um resumo em linguagem natural
// POST /api/ia/resumo-estoque
// Body: { fabricantes, lojas, ranking, filtros }
app.post('/api/ia/resumo-estoque', async function (req, res) {
  try {
    var dados = req.body;
    var filtros = dados.filtros || {};

    // Monta contexto dos dados para a IA
    var contexto = [];

    contexto.push('=== DADOS DO ESTOQUE ATUAL ===');

    if (filtros.loja) contexto.push('Filtro ativo: Loja ' + filtros.loja);
    if (filtros.fabricante) contexto.push('Filtro ativo: Fabricante ' + filtros.fabricante);
    if (filtros.dataRef) contexto.push('Data de referência: ' + filtros.dataRef);

    if (dados.fabricantes && dados.fabricantes.length) {
      contexto.push('\n--- POR FABRICANTE ---');
      dados.fabricantes.forEach(function (f) {
        contexto.push(
          (f.FABRICANTE || '—') + ': ' +
          parseFloat(f.SALDO_TOTAL).toFixed(3) + 'g | ' +
          f.QTD_PRODUTOS + ' produtos'
        );
      });
    }

    if (dados.lojas && dados.lojas.length) {
      contexto.push('\n--- POR LOJA ---');
      dados.lojas.forEach(function (l) {
        contexto.push(
          (l.NOME_LOJA || 'Loja ' + l.ESTABELECIMENTO) + ': ' +
          parseFloat(l.SALDO_TOTAL).toFixed(3) + 'g | ' +
          l.QTD_PRODUTOS + ' produtos'
        );
      });
    }

    if (dados.ranking && dados.ranking.length) {
      contexto.push('\n--- RANKING FABRICANTES ---');
      dados.ranking.forEach(function (r, i) {
        contexto.push(
          (i + 1) + 'º ' + (r.FABRICANTE || '—') + ': ' +
          parseFloat(r.SALDO_TOTAL).toFixed(3) + 'g'
        );
      });
    }

    var prompt = [
      'Com base nos dados abaixo, gere um resumo executivo do estoque.',
      'Destaque: total em estoque, distribuição entre fabricantes, loja com mais estoque,',
      'e qualquer insight relevante para a gestão.',
      '',
      contexto.join('\n'),
    ].join('\n');

    var resposta = await chamarOpenAI([{ role: 'user', content: prompt }], 600);
    res.json({ resumo: resposta });
  } catch (err) {
    if (err.message === 'OPENAI_KEY_MISSING') return res.status(200).json({ resumo: '⚠️ Chave da OpenAI não configurada no .env' });
    res.status(500).json({ erro: 'Erro interno no servidor.' });;
  }
});


// ── 3. ANÁLISE POR LINGUAGEM NATURAL ─────────────────────────
// Usuário faz uma pergunta e a IA busca os dados e responde
// POST /api/ia/analisar-estoque
// Body: { pergunta: "Qual loja tem mais aliancas?" }
app.post('/api/ia/analisar-estoque', async function (req, res) {
  try {
    var pergunta = req.body.pergunta;
    if (!pergunta) return res.status(400).json({ erro: 'Pergunta não informada.' });

    // Busca dados atuais do banco para dar contexto à IA
    var dataRef = dataHoje();
    var sql =
      'SELECT' +
      '  TRIM(CF.NOME) AS FABRICANTE,' +
      '  COALESCE(TRIM(EST.FANTASIA), TRIM(EST.NOME)) AS LOJA,' +
      '  PE.INTERNO_EST AS COD_LOJA,' +
      '  TRIM(P.NOME) AS PRODUTO,' +
      '  P.CODIGO,' +
      '  COALESCE(POS.SALDO_FINAL_PROPRIO, 0) AS SALDO' +
      ' FROM PRODUTO_ESTABELECIMENTO PE' +
      ' INNER JOIN PRODUTO P ON P.INTERNO = PE.INTERNO_PRODUTO' +
      ' INNER JOIN CLIENTE_FORNECEDOR CF ON CF.INTERNO = P.INTERNO_FABRICANTE' +
      ' LEFT JOIN ESTABELECIMENTO EST ON EST.INTERNO = PE.INTERNO_EST' +
      ' LEFT JOIN SP_POSICAO_ESTOQUE_MOD3(' +
      '   2, PE.INTERNO, NULL,' +
      "   '" + dataRef + "', '" + dataRef + "', 'Não'" +
      ' ) POS ON 0 = 0' +
      " WHERE P.ATIVO = 'Ativo'" +
      " AND P.TIPO = 'Produto'" +
      ' AND TRIM(CF.NOME) IN (' + FABRICANTES_IN + ')' +
      ' AND COALESCE(POS.SALDO_FINAL_PROPRIO, 0) <> 0' +
      ' ORDER BY CF.NOME, EST.NOME, P.NOME';

    var cacheKey = 'ia_estoque_completo:' + dataRef;
    var dados = await comCache(cacheKey, async function () {
      return await query(sql, []);
    });

    // Resume os dados para não estourar o contexto
    var resumoFab = {};
    var resumoLoja = {};
    var resumoProd = {};

    dados.forEach(function (r) {
      var fab = r.FABRICANTE || '—';
      var loja = r.LOJA || 'Loja ' + r.COD_LOJA;
      var prod = r.PRODUTO || '—';
      var s = parseFloat(r.SALDO) || 0;

      if (!resumoFab[fab]) resumoFab[fab] = 0;
      if (!resumoLoja[loja]) resumoLoja[loja] = 0;
      if (!resumoProd[prod]) resumoProd[prod] = { saldo: 0, fab: fab };

      resumoFab[fab] += s;
      resumoLoja[loja] += s;
      resumoProd[prod].saldo += s;
    });

    // Top 20 produtos por saldo
    var topProd = Object.entries(resumoProd)
      .sort(function (a, b) { return b[1].saldo - a[1].saldo; })
      .slice(0, 20)
      .map(function (e) { return e[0] + ' (' + e[1].fab + '): ' + e[1].saldo.toFixed(3) + 'g'; });

    var contextoIA = [
      '=== ESTOQUE ATUAL DA VITRINE — ' + dataRef + ' ===',
      '',
      '--- TOTAL POR FABRICANTE ---',
      Object.entries(resumoFab).map(function (e) { return e[0] + ': ' + e[1].toFixed(3) + 'g'; }).join('\n'),
      '',
      '--- TOTAL POR LOJA ---',
      Object.entries(resumoLoja).sort(function (a, b) { return b[1] - a[1]; }).map(function (e) { return e[0] + ': ' + e[1].toFixed(3) + 'g'; }).join('\n'),
      '',
      '--- TOP 20 PRODUTOS POR SALDO ---',
      topProd.join('\n'),
    ].join('\n');

    var mensagens = [
      { role: 'user', content: contextoIA + '\n\n=== PERGUNTA ===\n' + pergunta }
    ];

    var resposta = await chamarOpenAI(mensagens, 800);
    res.json({ resposta: resposta, dados_consultados: dados.length });

  } catch (err) {
    if (err.message === 'OPENAI_KEY_MISSING') return res.status(200).json({ resposta: '⚠️ Chave da OpenAI não configurada no .env' });
    res.status(500).json({ erro: 'Erro interno no servidor.' });;
  }
});

// ── 4. ANÁLISE DE CONTRATOS ───────────────────────────────────
// Recebe dados de contratos e retorna análise
// POST /api/ia/analisar-contratos
// Body: { contratos: [...], pergunta: "..." }
app.post('/api/ia/analisar-contratos', async function (req, res) {
  try {
    var contratos = req.body.contratos || [];
    var pergunta = req.body.pergunta || 'Faça uma análise geral dos contratos.';

    if (!contratos.length) {
      return res.status(400).json({ erro: 'Nenhum contrato enviado para análise.' });
    }

    // Sumariza os contratos para a IA
    var totalValor = contratos.reduce(function (s, c) { return s + (parseFloat(c.VALOR_TOTAL) || 0); }, 0);
    var porSituacao = {};
    contratos.forEach(function (c) {
      var sit = c.SITUACAO_CONTRATO || 'ATV';
      porSituacao[sit] = (porSituacao[sit] || 0) + 1;
    });

    var lista = contratos.slice(0, 30).map(function (c) {
      return '  • Pedido ' + c.NUMERO_PEDIDO +
        ' | Contrato ' + (c.CONTRATO || '—') +
        ' | Cliente: ' + (c.NOME_CLIENTE || '—') +
        ' | Valor: R$ ' + parseFloat(c.VALOR_TOTAL || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 }) +
        ' | Situação: ' + (c.SITUACAO_CONTRATO || 'ATV') +
        ' | Data: ' + (c.DATA_EMISSAO || '—');
    }).join('\n');

    var contexto = [
      '=== CONTRATOS DE COMPRA ===',
      'Total de contratos: ' + contratos.length,
      'Valor total: R$ ' + totalValor.toLocaleString('pt-BR', { minimumFractionDigits: 2 }),
      'Por situação: ' + Object.entries(porSituacao).map(function (e) { return e[0] + ': ' + e[1]; }).join(', '),
      '',
      '--- LISTA DE CONTRATOS ---',
      lista,
      contratos.length > 30 ? '  ... e mais ' + (contratos.length - 30) + ' contratos.' : '',
    ].join('\n');

    var resposta = await chamarOpenAI([
      { role: 'user', content: contexto + '\n\n=== PERGUNTA ===\n' + pergunta }
    ], 800);

    res.json({ resposta: resposta });
  } catch (err) {
    res.status(500).json({ erro: 'Erro interno no servidor.' });;
  }
});


// ── INICIA O SERVIDOR ─────────────────────────────────────────
var PORT = process.env.PORT || 3002;
app.listen(PORT, '0.0.0.0', function () {
  console.log('\n💎 API de Classificacao — Ourobras');
  console.log(' Servidor rodando em http://localhost:' + PORT);
  console.log(' Banco: ' + fbOptions.database);
  console.log(' Fabricantes monitorados:');
  FABRICANTES_FIXOS.forEach(function (f) { console.log('   • ' + f); });
  console.log('\n Endpoints disponíveis:');
  console.log('   GET /api/ping');
  console.log('   GET /api/estabelecimentos');
  console.log('   GET /api/fabricantes');
  console.log('   GET /api/estoque                  ?interno_est=1');
  console.log('   GET /api/estoque/por-fabricante   ?interno_est=1');
  console.log('   GET /api/estoque/por-loja');
  console.log('   GET /api/estoque/fabricante-por-loja');
  console.log('   GET /api/estoque/ranking');
  console.log('   POST /api/cache/limpar');
  console.log('   GET  /api/cache/status');
  console.log('   POST /api/ia/chat');
  console.log('   POST /api/ia/resumo-estoque');
  console.log('   POST /api/ia/analisar-estoque');
  console.log('   POST /api/ia/analisar-contratos');
  console.log('   GET  /api/vendas                  ?data_inicio=YYYY-MM-DD&data_fim=YYYY-MM-DD&interno_est=1&fabricante=X&coordenador=Bruno');
  console.log('   GET  /api/coordenadores\n');
});

// ════════════════════════════════════════════════════════════
// AUTENTICAÇÃO — Login com JWT
// Adicione USUARIOS no .env: ADMIN_USER=admin ADMIN_PASS=suaSenhaForte
// ════════════════════════════════════════════════════════════

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRY = '8h';

// Usuário administrador — senha armazenada como hash bcrypt no .env (ADMIN_PASS_HASH)
// Para gerar o hash, rode: node -e "const b=require('bcryptjs'); console.log(b.hashSync('SUA_SENHA_AQUI', 12))"
const ADMIN_USER = process.env.ADMIN_USER;
const ADMIN_PASS_HASH = process.env.ADMIN_PASS_HASH;

app.post('/api/auth/login', function (req, res) {
  var { usuario, senha } = req.body;
  if (!usuario || !senha) {
    return res.status(400).json({ erro: 'Usuário e senha obrigatórios.' });
  }

  // Valida usuário e compara senha com hash bcrypt
  if (usuario !== ADMIN_USER || !bcrypt.compareSync(senha, ADMIN_PASS_HASH)) {
    console.warn('[Auth] Tentativa de login falhou para: ' + usuario + ' | IP: ' + req.ip);
    // Delay fixo para dificultar timing attacks
    return setTimeout(function () {
      res.status(401).json({ erro: 'Usuário ou senha incorretos.' });
    }, 500);
  }

  var token = jwt.sign({ usuario: usuario }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
  console.log('[Auth] Login bem-sucedido: ' + usuario);
  res.json({ token: token, expira_em: JWT_EXPIRY });
});