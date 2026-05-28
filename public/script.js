// ── Verificação de autenticação ──────────────────────────────
(function () {
  var token = localStorage.getItem('ourobras_token');
  if (!token) {
    window.location.href = '/login.html';
    return;
  }
  // Verifica se o token expirou (decodifica o payload JWT)
  try {
    var payload = JSON.parse(atob(token.split('.')[1]));
    if (payload.exp * 1000 < Date.now()) {
      localStorage.removeItem('ourobras_token');
      window.location.href = '/login.html';
    }
  } catch (e) {
    localStorage.removeItem('ourobras_token');
    window.location.href = '/login.html';
  }
})();

// ── Função global para chamadas autenticadas ─────────────────
function apiFetch(url, opts) {
  opts = opts || {};
  opts.headers = opts.headers || {};

  var token = localStorage.getItem('ourobras_token');
  if (!token) {
    localStorage.removeItem('ourobras_token');
    window.location.href = '/login.html';
    return Promise.reject(new Error('Token ausente'));
  }

  opts.headers['Authorization'] = 'Bearer ' + token;

  return fetch(url, opts).then(function (r) {
    if (r.status === 401) {
      localStorage.removeItem('ourobras_token');
      window.location.href = '/login.html';
      throw new Error('Sessão expirada');
    }
    return r;
  });
}

// Substitua todos os fetch('/api/...') por apiFetch('/api/...')

/* ════════════════════════════════════════════════
   GLOBALS
════════════════════════════════════════════════ */
var chartFabE = null, chartLojaE = null, chartPizzaE = null;
var chartFabV = null, chartLojaV = null;
var coordenadoresMap = {};
var produtosCarregados = false, todosProdutos = [], produtosAbertos = false;
var vCoordAtivo = null;
var chatAberto = false, chatMinimizado = false, chatHistorico = [];
var abaAtiva = 'estoque';

var PALETTE = [
  '#1A3A6B', '#A8762A', '#166534', '#7c3aed',
  '#0891b2', '#c2410c', '#1E5F8A', '#1A6B45', '#7B3074', '#b45309'
];

function fmt(v, dec) {
  return (parseFloat(v) || 0).toLocaleString('pt-BR', { maximumFractionDigits: dec !== undefined ? dec : 2 });
}
function nomeFab(n) { return (n || 'Sem Fabricante').trim(); }
function nomeLoja(n, cod) { return (n || 'Est. ' + cod).trim(); }

/* ── RELÓGIO ────────────────────────────────── */
setInterval(function () {
  var el = document.getElementById('hora');
  if (el) el.textContent = new Date().toLocaleTimeString('pt-BR');
}, 1000);

/* ── TOAST ──────────────────────────────────── */
function showToast(msg, tipo) {
  var t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show' + (tipo === 'ok' ? ' success' : '');
  clearTimeout(t._t);
  t._t = setTimeout(function () { t.classList.remove('show'); }, 4000);
}

/* ════════════════════════════════════════════════
   NAVEGAÇÃO POR ABAS
════════════════════════════════════════════════ */
function mudarAba(aba, btn) {
  abaAtiva = aba;
  document.querySelectorAll('.tab-panel').forEach(function (p) { p.classList.remove('active'); });
  document.querySelectorAll('.tab-btn').forEach(function (b) { b.classList.remove('active'); });
  document.getElementById('panel-' + aba).classList.add('active');
  btn.classList.add('active');
}

/* ════════════════════════════════════════════════
   PING / STATUS
════════════════════════════════════════════════ */
async function ping() {
  var b = document.getElementById('statusBadge');
  try {
    var d = await fetch('/api/ping').then(function (r) { return r.json(); });
    if (d.status === 'ok') {
      b.innerHTML = '<span class="status-dot"></span> Conectado';
      b.className = 'status-badge';
    } else throw new Error();
  } catch (e) {
    b.innerHTML = '<span class="status-dot"></span> Offline';
    b.className = 'status-badge erro';
  }
}

/* ════════════════════════════════════════════════
   ESTOQUE — FILTROS
════════════════════════════════════════════════ */
async function carregarFiltros() {
  try {
    var [dl, df, dc] = await Promise.all([
      apiFetch('/api/estabelecimentos').then(function (r) { return r.json(); }),
      apiFetch('/api/fabricantes').then(function (r) { return r.json(); }),
      apiFetch('/api/coordenadores').then(function (r) { return r.json(); }).catch(function () { return { coordenadores: {} }; }),
    ]);
    coordenadoresMap = (dc && dc.coordenadores) ? dc.coordenadores : {};
    var selL = document.getElementById('selLoja');
    selL.innerHTML = '<option value="">— Todas as lojas —</option>';
    (dl.estabelecimentos || []).forEach(function (e) {
      var o = document.createElement('option');
      o.value = e.INTERNO;
      o.textContent = e.INTERNO + ' — ' + (e.FANTASIA || e.NOME || '').trim();
      selL.appendChild(o);
    });
    var selF = document.getElementById('selFabricante');
    selF.innerHTML = '<option value="">— Todos os fabricantes —</option>';
    (df.fabricantes || []).forEach(function (f) {
      var o = document.createElement('option');
      o.value = f.INTERNO;
      o.textContent = (f.NOME || '').trim();
      selF.appendChild(o);
    });
    var selC = document.getElementById('selCoord');
    selC.innerHTML = '<option value="">— Todos —</option>';
    Object.keys(coordenadoresMap).forEach(function (nome) {
      var o = document.createElement('option');
      o.value = nome;
      o.textContent = nome + ' (' + (coordenadoresMap[nome] || []).length + ' lojas)';
      selC.appendChild(o);
    });
  } catch (e) { console.error(e); }
}

function getParams() {
  var p = new URLSearchParams();
  var loja = document.getElementById('selLoja').value;
  var fab = document.getElementById('selFabricante').value;
  var teor = document.getElementById('selTeor').value;
  if (loja) p.set('interno_est', loja);
  if (fab) p.set('fabricante', fab);
  if (teor) p.set('teor', teor);
  return p;
}

function getCoordSelecionado() {
  var el = document.getElementById('selCoord');
  return el ? el.value : '';
}

/* ── Estoque por coordenador ─────────────────── */
async function carregarProdutosPorCoordenador(coordNome) {
  var lojas = coordenadoresMap[coordNome] || [];
  var fab = document.getElementById('selFabricante').value;
  var teor = document.getElementById('selTeor').value;
  var reqs = lojas.map(async function (codLoja) {
    var p = new URLSearchParams();
    p.set('interno_est', codLoja);
    if (fab) p.set('fabricante', fab);
    if (teor) p.set('teor', teor);
    p.set('limite', 9999);
    var d = await apiFetch('/api/estoque?' + p).then(function (r) { return r.json(); });
    return { loja: codLoja, data_ref: d.data_ref || 'hoje', estoque: d.estoque || [] };
  });
  var respostas = await Promise.all(reqs);
  var todos = []; var dataRef = 'hoje';
  respostas.forEach(function (r) { if (r.data_ref) dataRef = r.data_ref; r.estoque.forEach(function (i) { todos.push(i); }); });
  return { produtos: todos, data_ref: dataRef, lojas: lojas };
}

function agregarDashboard(produtos) {
  var fabM = {}, lojaM = {}, rankM = {};
  produtos.forEach(function (p) {
    var fab = nomeFab(p.FABRICANTE); var cod = parseInt(p.ESTABELECIMENTO) || 0;
    var nl = nomeLoja(p.NOME_ESTABELECIMENTO, cod); var s = parseFloat(p.SALDO) || 0;
    var cp = String(p.CODIGO || '') + '|' + fab;
    if (!fabM[fab]) fabM[fab] = { FABRICANTE: fab, QTD_PRODUTOS: 0, SALDO_TOTAL: 0, _p: {} };
    if (!fabM[fab]._p[cp]) { fabM[fab]._p[cp] = 1; fabM[fab].QTD_PRODUTOS++; }
    fabM[fab].SALDO_TOTAL += s;
    if (!lojaM[cod]) lojaM[cod] = { ESTABELECIMENTO: cod, NOME_LOJA: nl, QTD_PRODUTOS: 0, SALDO_TOTAL: 0, _p: {} };
    if (!lojaM[cod]._p[cp]) { lojaM[cod]._p[cp] = 1; lojaM[cod].QTD_PRODUTOS++; }
    lojaM[cod].SALDO_TOTAL += s;
    if (!rankM[fab]) rankM[fab] = { FABRICANTE: fab, QTD_PRODUTOS: 0, QTD_LOJAS: 0, SALDO_TOTAL: 0, _p: {}, _l: {} };
    if (!rankM[fab]._p[cp]) { rankM[fab]._p[cp] = 1; rankM[fab].QTD_PRODUTOS++; }
    if (!rankM[fab]._l[cod]) { rankM[fab]._l[cod] = 1; rankM[fab].QTD_LOJAS++; }
    rankM[fab].SALDO_TOTAL += s;
  });
  var sort = function (m) { return Object.values(m).sort(function (a, b) { return b.SALDO_TOTAL - a.SALDO_TOTAL; }); };
  return {
    fabricantes: sort(fabM), lojas: sort(lojaM), ranking: sort(rankM),
    total_saldo: produtos.reduce(function (s, p) { return s + (parseFloat(p.SALDO) || 0); }, 0),
    total_itens: produtos.length
  };
}

/* ── Render KPIs e Gráficos Estoque ─────────── */
function renderKpisEstoque(fabs, lojas, total, totalItens, dataRef) {
  function formatarDataBR(data) {
    if (!data) return 'hoje';

    // tenta converter
    const d = new Date(data);

    // valida data
    if (isNaN(d)) return data;

    return d.toLocaleDateString('pt-BR');
  }

  document.getElementById('kpiDataRef').textContent = 'Ref: ' + formatarDataBR(dataRef);
  document.getElementById('kpiTotal').textContent = fmt(total, 3) + ' g';
  document.getElementById('kpiFabricantes').textContent = fabs.length;
  document.getElementById('kpiItens').textContent = (totalItens || 0).toLocaleString('pt-BR');
  document.getElementById('kpiLojas').textContent = lojas.length;
  if (fabs.length) {
    document.getElementById('kpiMaiorFab').textContent = nomeFab(fabs[0].FABRICANTE).substring(0, 22);
    document.getElementById('kpiMaiorFabSub').textContent = fmt(fabs[0].SALDO_TOTAL, 3) + ' g';
  }
  if (lojas.length) {
    document.getElementById('kpiMaiorLoja').textContent = nomeLoja(lojas[0].NOME_LOJA, lojas[0].ESTABELECIMENTO).substring(0, 20);
    document.getElementById('kpiMaiorLojaSub').textContent = fmt(lojas[0].SALDO_TOTAL, 3) + ' g';
  }
}

function renderChartsEstoque(fabs, lojas) {
  // Barras fabricante
  if (chartFabE) chartFabE.destroy();
  chartFabE = new Chart(document.getElementById('chartFabricante'), {
    type: 'bar',
    data: {
      labels: fabs.map(function (f) { var n = nomeFab(f.FABRICANTE); return n.length > 22 ? n.slice(0, 22) + '…' : n; }),
      datasets: [{
        label: 'Saldo', data: fabs.map(function (f) { return parseFloat(f.SALDO_TOTAL) || 0; }),
        backgroundColor: PALETTE.map(function (c) { return c + 'cc'; }), borderColor: PALETTE, borderWidth: 2, borderRadius: 6
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: function (c) { return ' ' + fmt(c.parsed.y, 3) + ' g'; } } } },
      scales: {
        x: { ticks: { color: '#8A8078', font: { size: 11 } }, grid: { color: '#E8E2D8' } },
        y: { ticks: { color: '#8A8078' }, grid: { color: '#E8E2D8' } }
      }
    }
  });
  // Pizza
  if (chartPizzaE) chartPizzaE.destroy();
  chartPizzaE = new Chart(document.getElementById('chartPizza'), {
    type: 'doughnut',
    data: {
      labels: fabs.map(function (f) { return nomeFab(f.FABRICANTE).substring(0, 24); }),
      datasets: [{
        data: fabs.map(function (f) { return parseFloat(f.SALDO_TOTAL) || 0; }),
        backgroundColor: PALETTE.map(function (c) { return c + 'cc'; }), borderColor: PALETTE, borderWidth: 2
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'right', labels: { color: '#4A4440', font: { size: 12 }, boxWidth: 14, padding: 12 } },
        tooltip: { callbacks: { label: function (c) { return ' ' + fmt(c.parsed, 3) + ' g'; } } }
      }
    }
  });
  // Lojas
  if (chartLojaE) chartLojaE.destroy();
  var horiz = lojas.length > 5;
  var alt = horiz ? Math.max(260, lojas.length * 34) : 220;
  document.getElementById('wrapLoja').style.height = alt + 'px';
  chartLojaE = new Chart(document.getElementById('chartLoja'), {
    type: 'bar',
    data: {
      labels: lojas.map(function (l) { return nomeLoja(l.NOME_LOJA, l.ESTABELECIMENTO); }),
      datasets: [{
        label: 'Saldo', data: lojas.map(function (l) { return parseFloat(l.SALDO_TOTAL) || 0; }),
        backgroundColor: PALETTE.map(function (c) { return c + 'cc'; }), borderColor: PALETTE, borderWidth: 2, borderRadius: 4
      }]
    },
    options: {
      indexAxis: horiz ? 'y' : 'x', responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: function (c) { var v = horiz ? c.parsed.x : c.parsed.y; return ' ' + fmt(v, 3) + ' g'; } } } },
      scales: {
        x: { ticks: { color: '#8A8078', font: { size: 11 } }, grid: { color: '#E8E2D8' } },
        y: { ticks: { color: '#4A4440', font: { size: horiz ? 11 : 10 } }, grid: { color: '#E8E2D8' } }
      }
    }
  });
}

/* ── Ranking ─────────────────────────────────── */
async function carregarRanking(p) {
  var el = document.getElementById('rankingFab');
  try {
    var d = await apiFetch('/api/estoque/ranking?limite=10&' + p).then(function (r) { return r.json(); });
    var ranking = d.ranking || []; var total = d.total_geral || 1;
    if (!ranking.length) { el.innerHTML = '<div class="empty">Nenhum dado encontrado.</div>'; return; }
    var maxVal = parseFloat(ranking[0].SALDO_TOTAL) || 1;
    var rows = ranking.map(function (r, i) {
      var pct = ((parseFloat(r.SALDO_TOTAL) || 0) / total * 100).toFixed(1);
      var bw = ((parseFloat(r.SALDO_TOTAL) || 0) / maxVal * 100).toFixed(0);
      return '<tr>' +
        '<td><strong>' + (i + 1) + '</strong></td>' +
        '<td>' + nomeFab(r.FABRICANTE).substring(0, 28) + '</td>' +
        '<td style="text-align:right">' + r.QTD_PRODUTOS + '</td>' +
        '<td style="text-align:right">' + r.QTD_LOJAS + '</td>' +
        '<td style="text-align:right" class="money">' + fmt(r.SALDO_TOTAL, 3) + ' g</td>' +
        '<td style="min-width:90px"><div class="prog-wrap"><div class="prog-bg"><div class="prog-fill" style="width:' + bw + '%"></div></div><span style="font-size:.72rem;color:#8A8078">' + pct + '%</span></div></td>' +
        '</tr>';
    }).join('');
    el.innerHTML = '<table class="dt"><thead><tr><th></th><th>Fabricante</th><th style="text-align:right">Produtos</th><th style="text-align:right">Lojas</th><th style="text-align:right">Saldo (g)</th><th>Part.%</th></tr></thead><tbody>' + rows + '</tbody></table>';
  } catch (e) { el.innerHTML = '<div class="empty">Erro ao carregar.</div>'; }
}

/* ── carregarTudo ────────────────────────────── */
async function carregarTudo() {
  var loja = document.getElementById('selLoja').value;
  var fab = document.getElementById('selFabricante').value;
  var coord = getCoordSelecionado();
  var p = getParams();

  if (coord && !loja) {
    try {
      var dc = await carregarProdutosPorCoordenador(coord);
      var agg = agregarDashboard(dc.produtos || []);
      renderKpisEstoque(agg.fabricantes, agg.lojas, agg.total_saldo, agg.total_itens, dc.data_ref);
      renderChartsEstoque(agg.fabricantes, agg.lojas);
      renderRankingLocal(agg.ranking);
      if (agg.fabricantes.length) gerarResumoIA(agg.fabricantes, agg.lojas, agg.ranking, { coordenador: coord });
    } catch (e) { console.error(e); }
    return;
  }

  await Promise.all([
    carregarResumoFabricante(p),
    carregarResumoLoja(p),
    carregarRanking(p),
  ]);
}

function renderRankingLocal(ranking) {
  var el = document.getElementById('rankingFab');
  if (!ranking.length) { el.innerHTML = '<div class="empty">Sem dados.</div>'; return; }
  var total = ranking.reduce(function (s, r) { return s + (parseFloat(r.SALDO_TOTAL) || 0); }, 0);
  var maxVal = parseFloat(ranking[0].SALDO_TOTAL) || 1;
  var rows = ranking.slice(0, 10).map(function (r, i) {
    var pct = ((parseFloat(r.SALDO_TOTAL) || 0) / total * 100).toFixed(1);
    var bw = ((parseFloat(r.SALDO_TOTAL) || 0) / maxVal * 100).toFixed(0);
    return '<tr><td><strong>' + (i + 1) + '</strong></td><td>' + nomeFab(r.FABRICANTE).substring(0, 28) + '</td>' +
      '<td style="text-align:right">' + r.QTD_PRODUTOS + '</td><td style="text-align:right">' + r.QTD_LOJAS + '</td>' +
      '<td style="text-align:right" class="money">' + fmt(r.SALDO_TOTAL, 3) + ' g</td>' +
      '<td><div class="prog-wrap"><div class="prog-bg"><div class="prog-fill" style="width:' + bw + '%"></div></div><span style="font-size:.72rem;color:#8A8078">' + pct + '%</span></div></td></tr>';
  }).join('');
  el.innerHTML = '<table class="dt"><thead><tr><th></th><th>Fabricante</th><th style="text-align:right">Produtos</th><th style="text-align:right">Lojas</th><th style="text-align:right">Saldo (g)</th><th>Part.%</th></tr></thead><tbody>' + rows + '</tbody></table>';
}

async function carregarResumoFabricante(p) {
  try {
    var d = await apiFetch('/api/estoque/por-fabricante?' + p).then(function (r) { return r.json(); });
    var fabs = d.fabricantes || []; var total = d.total_saldo || 0;
    var itens = fabs.reduce(function (s, f) { return s + (f.QTD_PRODUTOS || 0); }, 0);
    renderKpisEstoque(fabs, [], total, itens, d.data_ref);
    renderChartsEstoque(fabs, []);
    var loja = document.getElementById('selLoja').value;
    if (loja || fabs.length) gerarResumoIA(fabs, [], [], { loja, fabricante: document.getElementById('selFabricante').value, dataRef: d.data_ref });
  } catch (e) { console.error(e); }
}

async function carregarResumoLoja(p) {
  try {
    var d = await apiFetch('/api/estoque/por-loja?' + p).then(function (r) { return r.json(); });
    var lojas = d.lojas || [];
    document.getElementById('kpiLojas').textContent = lojas.length;
    if (lojas.length) {
      document.getElementById('kpiMaiorLoja').textContent = nomeLoja(lojas[0].NOME_LOJA, lojas[0].ESTABELECIMENTO).substring(0, 20);
      document.getElementById('kpiMaiorLojaSub').textContent = fmt(lojas[0].SALDO_TOTAL, 3) + ' g';
    }
    // Atualiza gráfico de lojas
    if (chartLojaE) chartLojaE.destroy();
    var horiz = lojas.length > 5;
    var alt = horiz ? Math.max(260, lojas.length * 34) : 220;
    document.getElementById('wrapLoja').style.height = alt + 'px';
    chartLojaE = new Chart(document.getElementById('chartLoja'), {
      type: 'bar',
      data: {
        labels: lojas.map(function (l) { return nomeLoja(l.NOME_LOJA, l.ESTABELECIMENTO); }),
        datasets: [{
          label: 'Saldo', data: lojas.map(function (l) { return parseFloat(l.SALDO_TOTAL) || 0; }),
          backgroundColor: PALETTE.map(function (c) { return c + 'cc'; }), borderColor: PALETTE, borderWidth: 2, borderRadius: 4
        }]
      },
      options: {
        indexAxis: horiz ? 'y' : 'x', responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: function (c) { var v = horiz ? c.parsed.x : c.parsed.y; return ' ' + fmt(v, 3) + ' g'; } } } },
        scales: { x: { ticks: { color: '#8A8078', font: { size: 11 } }, grid: { color: '#E8E2D8' } }, y: { ticks: { color: '#4A4440', font: { size: horiz ? 11 : 10 } }, grid: { color: '#E8E2D8' } } }
      }
    });
  } catch (e) { console.error(e); }
}

/* ── Produtos ────────────────────────────────── */
function resetProdutos() {
  produtosCarregados = false; todosProdutos = [];
  document.getElementById('countProdutos').textContent = '';
  if (produtosAbertos) {
    document.getElementById('produtosConteudo').innerHTML =
      '<div style="text-align:center;padding:24px;color:var(--text-3)">Filtros alterados. Clique em <strong>Ver Produtos</strong> para recarregar.</div>';
  }
}

function toggleProdutos() {
  var area = document.getElementById('produtosArea');
  var btn = document.getElementById('btnVerProdutos');
  produtosAbertos = !produtosAbertos;
  if (produtosAbertos) {
    area.style.display = 'block';
    btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="18 15 12 9 6 15"/></svg> Ocultar';
    btn.style.background = '#4A4440';
    if (!produtosCarregados) carregarProdutos();
  } else {
    area.style.display = 'none';
    btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg> Ver Produtos';
    btn.style.background = 'var(--accent)';
  }
}

async function carregarProdutos() {
  var conteudo = document.getElementById('produtosConteudo');
  var loja = document.getElementById('selLoja').value;
  var fab = document.getElementById('selFabricante').value;
  var coord = getCoordSelecionado();
  if (coord && !loja) {
    try {
      var dc = await carregarProdutosPorCoordenador(coord);
      todosProdutos = dc.produtos || []; produtosCarregados = true;
      document.getElementById('filtroProduto').value = '';
      renderProdutosPorFabricante(todosProdutos);
    } catch (e) { conteudo.innerHTML = '<div style="text-align:center;padding:24px;color:var(--danger)">❌ ' + e.message + '</div>'; }
    return;
  }
  if (!loja && !fab) {
    conteudo.innerHTML = '<div style="text-align:center;padding:24px;background:var(--accent-lt);border-radius:8px;font-size:.88rem;color:var(--accent)"> Selecione uma <strong>loja</strong> ou um <strong>fabricante</strong>.</div>';
    return;
  }
  conteudo.innerHTML = '<div style="text-align:center;padding:32px"><div class="spinner"></div><br><span style="color:var(--text-3);font-size:.85rem">Buscando produtos...</span></div>';
  try {
    var p = getParams(); p.set('limite', 9999);
    var d = await apiFetch('/api/estoque?' + p).then(function (r) { return r.json(); });
    if (d.erro) { conteudo.innerHTML = '<div style="text-align:center;padding:24px;color:var(--danger)">❌ ' + d.erro + '</div>'; return; }
    todosProdutos = d.estoque || []; produtosCarregados = true;
    document.getElementById('filtroProduto').value = '';
    renderProdutosPorFabricante(todosProdutos);
  } catch (e) { conteudo.innerHTML = '<div style="text-align:center;padding:24px;color:var(--danger)">❌ ' + e.message + '</div>'; }
}

function extrairFamilia(nome) {
  if (!nome) return 'OUTROS';
  return nome.trim().split(/\s+/)[0].toUpperCase() || 'OUTROS';
}

function renderProdutosPorFabricante(dados) {
  var conteudo = document.getElementById('produtosConteudo');
  var count = document.getElementById('countProdutos');
  if (!dados.length) { conteudo.innerHTML = '<div class="empty">Nenhum produto encontrado.</div>'; count.textContent = ''; return; }
  var saldoTotal = dados.reduce(function (s, p) { return s + (parseFloat(p.SALDO) || 0); }, 0);
  count.textContent = dados.length.toLocaleString('pt-BR') + ' produto(s) · Saldo total: ' + fmt(saldoTotal, 3) + ' g';
  var grupos = {};
  dados.forEach(function (p) {
    var fab = (p.FABRICANTE || 'Sem Fabricante').trim();
    var fam = extrairFamilia(p.NOME);
    if (!grupos[fab]) grupos[fab] = { saldo: 0, familias: {} };
    grupos[fab].saldo += parseFloat(p.SALDO) || 0;
    if (!grupos[fab].familias[fam]) grupos[fab].familias[fam] = { saldo: 0, qtd: 0, produtos: [] };
    grupos[fab].familias[fam].saldo += parseFloat(p.SALDO) || 0;
    grupos[fab].familias[fam].qtd++;
    grupos[fab].familias[fam].produtos.push(p);
  });
  var fabsOrd = Object.keys(grupos).sort(function (a, b) { return grupos[b].saldo - grupos[a].saldo; });
  var html = '';
  fabsOrd.forEach(function (fab, fi) {
    var g = grupos[fab]; var fId = 'fab_' + fi;
    var qtdT = Object.values(g.familias).reduce(function (s, f) { return s + f.qtd; }, 0);
    var isOpen = fabsOrd.length === 1;
    html += '<div class="fab-section">';
    html += '<div class="fab-header" onclick="toggleFab(\'' + fId + '\')">';
    html += '<div class="fab-header-title">📦 ' + fab + '</div>';
    html += '<div class="fab-header-meta"><span>' + qtdT + ' produtos</span><span>Saldo: <strong>' + fmt(g.saldo, 3) + ' g</strong></span><span id="seta_' + fId + '">' + (isOpen ? '▲' : '▼') + '</span></div>';
    html += '</div>';
    html += '<div id="' + fId + '" class="fab-body' + (isOpen ? ' open' : '') + '" style="padding:0">';
    var famOrd = Object.keys(g.familias).sort(function (a, b) { return g.familias[b].saldo - g.familias[a].saldo; });
    famOrd.forEach(function (fam, fmi) {
      var fm = g.familias[fam]; var fmId = fId + '_f' + fmi; var fmOpen = famOrd.length === 1;
      html += '<div style="border-bottom:1px solid var(--border)">';
      html += '<div onclick="toggleFab(\'' + fmId + '\')" style="display:flex;align-items:center;justify-content:space-between;padding:9px 16px;background:var(--bg);cursor:pointer;border-left:3px solid var(--gold)">';
      html += '<span style="font-size:.85rem;font-weight:700;color:var(--gold)">🔖 ' + fam + '</span>';
      html += '<span style="font-size:.78rem;color:var(--text-3);display:flex;gap:14px;align-items:center"><span>' + fm.qtd + ' itens</span><span class="money">' + fmt(fm.saldo, 3) + ' g</span><span id="seta_' + fmId + '">' + (fmOpen ? '▲' : '▼') + '</span></span>';
      html += '</div>';
      html += '<div id="' + fmId + '" class="fab-body' + (fmOpen ? ' open' : '') + '"><table class="dt"><thead><tr><th>Código</th><th>Produto</th><th style="text-align:center">Est.</th><th>Loja</th><th style="text-align:right">Saldo (g)</th></tr></thead><tbody>';
      fm.produtos.forEach(function (p) {
        html += '<tr><td><strong>' + p.CODIGO + '</strong></td><td>' + (p.NOME || '—') + '</td><td style="text-align:center">' + p.ESTABELECIMENTO + '</td><td>' + (p.NOME_ESTABELECIMENTO || '—') + '</td><td style="text-align:right" class="money">' + fmt(p.SALDO, 3) + ' g</td></tr>';
      });
      html += '</tbody></table></div></div>';
    });
    html += '</div></div>';
  });
  conteudo.innerHTML = html;
}

function toggleFab(id) {
  var body = document.getElementById(id); var seta = document.getElementById('seta_' + id);
  if (!body) return;
  if (body.classList.contains('open')) { body.classList.remove('open'); seta.textContent = '▼'; }
  else { body.classList.add('open'); seta.textContent = '▲'; }
}

function filtrarProdutos() {
  if (!produtosCarregados) return;
  var t = document.getElementById('filtroProduto').value.toLowerCase();
  var d = t ? todosProdutos.filter(function (p) { return (p.NOME || '').toLowerCase().includes(t) || (p.FABRICANTE || '').toLowerCase().includes(t) || String(p.CODIGO || '').includes(t); }) : todosProdutos;
  renderProdutosPorFabricante(d);
}

async function limparCacheAPI() {
  try {
    await apiFetch('/api/cache/limpar', { method: 'POST' });
    resetProdutos();
    showToast('✅ Cache limpo! Próxima consulta buscará dados atualizados.', 'ok');
  } catch (e) { showToast('Erro: ' + e.message); }
}

/* ════════════════════════════════════════════════
   VENDAS
════════════════════════════════════════════════ */
// Datas padrão
(function () {
  var hoje = new Date();
  var ini = new Date(hoje.getFullYear(), hoje.getMonth(), 1);
  function fi(d) { return d.toISOString().slice(0, 10); }
  document.getElementById('vDataInicio').value = fi(ini);
  document.getElementById('vDataFim').value = fi(hoje);
})();

function toggleCoordV(el) {
  var coord = el.dataset.coord;
  var classes = { Bruno: 'b-active', Gabriel: 'g-active', Raiane: 'r-active' };
  if (vCoordAtivo === coord) {
    vCoordAtivo = null;
    el.classList.remove('active', classes[coord] || 'active');
  } else {
    document.querySelectorAll('.coord-pill').forEach(function (p) {
      p.classList.remove('active', 'b-active', 'g-active', 'r-active');
    });
    vCoordAtivo = coord;
    el.classList.add('active', classes[coord] || 'active');
    document.getElementById('vLoja').value = '';
  }
}

function limparVendas() {
  vCoordAtivo = null;
  document.querySelectorAll('.coord-pill').forEach(function (p) { p.classList.remove('active', 'b-active', 'g-active', 'r-active'); });
  document.getElementById('vLoja').value = '';
  document.getElementById('vFabricante').value = '';
  var hoje = new Date(); var ini = new Date(hoje.getFullYear(), hoje.getMonth(), 1);
  document.getElementById('vDataInicio').value = ini.toISOString().slice(0, 10);
  document.getElementById('vDataFim').value = hoje.toISOString().slice(0, 10);
}

function badgeFab(nome) {
  if (!nome) return '<span class="badge-fab badge-other">—</span>';
  var u = nome.toUpperCase();
  if (u.includes('SG METAIS')) return '<span class="badge-fab badge-sg">SG Metais</span>';
  if (u.includes('MANTOVANI')) return '<span class="badge-fab badge-mant">Mantovani</span>';
  if (u.includes('ELLOS')) return '<span class="badge-fab badge-ellos">Ellos Gold</span>';
  return '<span class="badge-fab badge-other">' + nome.split(' ')[0] + '</span>';
}

function abrevFab(nome) {
  if (!nome) return '—';
  var u = nome.toUpperCase();
  if (u.includes('SG METAIS')) return 'SG Metais';
  if (u.includes('MANTOVANI')) return 'Mantovani';
  if (u.includes('ELLOS')) return 'Ellos Gold';
  return nome.split(' ')[0];
}

function fmtData(v) {
  if (!v) return '—';
  if (typeof v === 'string' && v.includes('T')) return new Date(v).toLocaleDateString('pt-BR');
  return String(v).slice(0, 10);
}

async function buscarVendas() {
  var di = document.getElementById('vDataInicio').value;
  var df = document.getElementById('vDataFim').value;
  var fab = document.getElementById('vFabricante').value;
  var lj = document.getElementById('vLoja').value;
  if (!di || !df) { showToast('⚠️ Informe o período de consulta.'); return; }
  if (di > df) { showToast('⚠️ Data início deve ser anterior à data fim.'); return; }
  var btn = document.getElementById('btnBuscarV');
  btn.disabled = true; btn.textContent = '⏳ Carregando...';
  var params = new URLSearchParams({ data_inicio: di, data_fim: df });
  if (fab) params.set('fabricante', fab);
  if (vCoordAtivo) params.set('coordenador', vCoordAtivo);
  else if (lj) params.set('interno_est', lj);
  try {
    var r = await apiFetch('/api/vendas?' + params);
    var data = await r.json();
    if (data.erro) { showToast('Erro: ' + data.erro); return; }
    renderVendas(data);
  } catch (e) { showToast('Falha ao conectar: ' + e.message); }
  finally { btn.disabled = false; btn.textContent = ' Consultar Vendas'; }
}

function renderVendas(data) {
  var vendas = data.vendas || [];
  var topProd = data.top_produtos || [];
  var porFab = data.por_fabricante || [];
  var porLoja = data.por_loja || [];
  var totalItens = data.total_itens || 0;
  var totalQtd = vendas.reduce(function (s, r) { return s + (parseFloat(r.QUANTIDADE) || 0); }, 0);
  var vc = document.getElementById('vendasContent');
  vc.innerHTML = '';

  // KPIs
  var kGrid = document.createElement('div');
  kGrid.className = 'kpi-grid-4';
  kGrid.innerHTML =
    vKpi('Total de Notas', totalItens.toLocaleString('pt-BR'), 'Lançamentos no Período') +
    vKpi('Itens Vendidos', totalQtd.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 0 }), 'Quantidade Total') +
    vKpi('Lojas com Venda', porLoja.length, 'Estabelecimentos Ativos') +
    vKpi('Top Produto', topProd.length ? topProd[0].produto.split(' ').slice(0, 3).join(' ') + '…' : '—', topProd.length ? topProd[0].quantidade.toFixed(0) + ' un.' : '');
  vc.appendChild(kGrid);

  // Charts row
  var cg = document.createElement('div');
  cg.className = 'v-charts-grid';

  var cFab = document.createElement('div');
  cFab.className = 'v-chart-card';
  cFab.innerHTML = '<div class="v-chart-title"><i class="fi fi-rr-chat-arrow-grow"></i></div> Por Fabricante</div><div class="v-chart-wrap"><canvas id="vChartFab"></canvas></div>';
  cg.appendChild(cFab);

  var cLoja = document.createElement('div');
  cLoja.className = 'v-chart-card';
  cLoja.innerHTML = '<div class="v-chart-title"><img src="/img/local.svg" alt="Local" width="18" height="18"> Top Lojas — Qtd Vendida</div><div class="v-chart-wrap"><canvas id="vChartLoja"></canvas></div>';
  cg.appendChild(cLoja);
  vc.appendChild(cg);

  // Top produtos
  var tpCard = document.createElement('div');
  tpCard.className = 'v-chart-card';
  var rankHtml = '<div class="v-chart-title"><img src="/img/rank.svg" width="18" style="vertical-align:middle; margin-right:6px;"> Top 20 Produtos Mais Vendidos</div><div class="rank-list">';
  var maxQ = topProd.length ? topProd[0].quantidade : 1;
  topProd.forEach(function (p, i) {
    var pct = (p.quantidade / maxQ * 100).toFixed(0);
    rankHtml += '<div class="rank-item">' +
      '<div class="rank-num' + (i < 3 ? ' gold' : '') + '">' + (i + 1) + '</div>' +
      '<div class="rank-bar-wrap">' +
      '<div class="rank-name">' + p.produto.substring(0, 50) + ' ' + badgeFab(p.fabricante) + '</div>' +
      '<div class="rank-bar-bg"><div class="rank-bar-fill" style="width:' + pct + '%"></div></div>' +
      '</div>' +
      '<div class="rank-qty">' + p.quantidade.toFixed(0) + '</div>' +
      '</div>';
  });
  rankHtml += '</div>';
  tpCard.innerHTML = rankHtml;
  vc.appendChild(tpCard);

  // Tabela
  var tCard = document.createElement('div');
  tCard.className = 'v-table-card';
  tCard.innerHTML =
    '<div class="v-table-header">' +
    '<div><div class="v-table-title"><img src="/img/search.svg" alt="Local" width="18" height="18"> Detalhamento de Vendas</div><div class="v-table-count">' + totalItens.toLocaleString('pt-BR') + ' registros</div></div>' +
    '<input class="v-search" placeholder=" Filtrar tabela…" oninput="filtrarTabelaV(this.value)"/>' +
    '</div>' +
    '<div class="v-table-wrap">' +
    '<table class="vt"><thead><tr><th>Nota</th><th>Data</th><th>Loja</th><th>Fabricante</th><th>Produto</th><th style="text-align:right">Qtd</th><th>Modelo</th></tr></thead>' +
    '<tbody id="tbodyV"></tbody></table></div>';
  vc.appendChild(tCard);

  var tbody = document.getElementById('tbodyV');
  vendas.forEach(function (r) {
    var tr = document.createElement('tr');
    tr.innerHTML =
      '<td style="font-weight:600;color:var(--text-1)">' + (r.NOTA_NUMERO || '—') + '</td>' +
      '<td>' + fmtData(r.DATA_EMISSAO) + '</td>' +
      '<td title="' + r.ESTABELECIMENTO + '">' + ((r.ESTABELECIMENTO || '').split(' - ').pop()) + '</td>' +
      '<td>' + badgeFab(r.FABRICANTE) + '</td>' +
      '<td title="' + r.PRODUTO + '">' + (r.PRODUTO || '').substring(0, 42) + (r.PRODUTO && r.PRODUTO.length > 42 ? '…' : '') + '</td>' +
      '<td style="text-align:right;font-weight:700;color:var(--gold)">' + parseFloat(r.QUANTIDADE || 0).toFixed(2) + '</td>' +
      '<td style="color:var(--text-3)">' + (r.MODELO || '—') + '</td>';
    tbody.appendChild(tr);
  });

  // Charts
  setTimeout(function () {
    if (chartFabV) chartFabV.destroy();
    chartFabV = new Chart(document.getElementById('vChartFab'), {
      type: 'doughnut',
      data: {
        labels: porFab.map(function (f) { return abrevFab(f.fabricante); }),
        datasets: [{
          data: porFab.map(function (f) { return f.quantidade; }),
          backgroundColor: ['#1A3A6B', '#A8762A', '#166534', '#7c3aed'],
          borderColor: '#FFFFFF', borderWidth: 3
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: '62%',
        plugins: {
          legend: { position: 'bottom', labels: { color: '#4A4440', font: { size: 12 }, padding: 14 } },
          tooltip: { callbacks: { label: function (c) { return ' ' + abrevFab(c.label) + ': ' + c.parsed.toFixed(0); } } }
        }
      }
    });
    if (chartLojaV) chartLojaV.destroy();
    var topL = porLoja.slice(0, 10);
    chartLojaV = new Chart(document.getElementById('vChartLoja'), {
      type: 'bar',
      data: {
        labels: topL.map(function (l) { return l.nome_loja.split(' - ').pop(); }),
        datasets: [{
          label: 'Qtd', data: topL.map(function (l) { return l.quantidade; }),
          backgroundColor: 'rgba(168,118,42,.75)', borderColor: '#A8762A', borderWidth: 1, borderRadius: 5
        }]
      },
      options: {
        indexAxis: 'y', responsive: true, maintainAspectRatio: false,
        scales: {
          x: { grid: { color: '#E8E2D8' }, ticks: { color: '#8A8078', font: { size: 11 } } },
          y: { grid: { display: false }, ticks: { color: '#1A1612', font: { size: 12 } } }
        },
        plugins: { legend: { display: false } }
      }
    });
  }, 50);
}

function vKpi(label, value, sub) {
  return '<div class="v-kpi"><div class="v-kpi-label">' + label + '</div><div class="v-kpi-valor">' + value + '</div><div class="v-kpi-sub">' + sub + '</div></div>';
}

function filtrarTabelaV(q) {
  q = q.toLowerCase();
  var rows = document.querySelectorAll('#tbodyV tr');
  rows.forEach(function (tr) { tr.style.display = tr.textContent.toLowerCase().includes(q) ? '' : 'none'; });
}

/* ════════════════════════════════════════════════
   CHAT IA MIDAS
════════════════════════════════════════════════ */
function toggleChat() {
  if (chatMinimizado) {
    chatMinimizado = false;
    document.getElementById('chatBox').classList.add('open');
    document.getElementById('chatBtn').textContent = '✕';
    chatAberto = true;
  } else if (chatAberto) {
    fecharChat();
  } else {
    abrirChat();
  }
}

function abrirChat() {
  chatAberto = true; chatMinimizado = false;
  document.getElementById('chatBox').classList.add('open');
  document.getElementById('chatBtn').textContent = '✕';
  setTimeout(function () { document.getElementById('chatInput').focus(); }, 100);
}

function fecharChat() {
  chatAberto = false;
  chatMinimizado = false;
  document.getElementById('chatBox').classList.remove('open');
  document.getElementById('chatBtn').innerHTML =
    '<img src="/img/assets/voice-bot.svg" class="chat-btn-icon" alt="Bot">';
}

function minimizarChat() {
  chatMinimizado = true; chatAberto = false;
  document.getElementById('chatBox').classList.remove('open');
  document.getElementById('chatBtn').innerHTML = '<img src="/img/assets/voice-bot.svg" class="chat-btn-icon" alt="Bot">';
  document.getElementById('chatBtn').classList.add('minimized');
}

function perguntaRapida(texto) {
  if (!chatAberto) abrirChat();
  document.getElementById('chatInput').value = texto;
  document.getElementById('chatQuick').style.display = 'none';
  enviarChat();
}

async function enviarChat() {
  var input = document.getElementById('chatInput');
  var texto = input.value.trim();
  if (!texto) return;
  var send = document.getElementById('chatSend');
  var msgs = document.getElementById('chatMsgs');
  chatHistorico.push({ role: 'user', content: texto });
  addMsg(texto, 'user');
  input.value = ''; input.style.height = 'auto';
  send.disabled = true;
  var loadId = 'load_' + Date.now();
  var loadRow = document.createElement('div');
  loadRow.className = 'msg-row'; loadRow.id = 'row_' + loadId;
  loadRow.innerHTML = '<div class="msg-icon ia-icon"><img src="/img/assets/voice-bot.svg" class="chat-icon"></div><div class="msg ia loading" id="' + loadId + '"><div class="dot-anim"><span></span><span></span><span></span></div></div>';
  msgs.appendChild(loadRow); msgs.scrollTop = msgs.scrollHeight;
  try {
    var d = await apiFetch('/api/ia/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mensagens: chatHistorico }) }).then(function (r) { return r.json(); });
    var el = document.getElementById('row_' + loadId); if (el) el.remove();
    var resp = d.resposta || d.erro || 'Erro ao processar.';
    chatHistorico.push({ role: 'assistant', content: resp });
    addMsg(resp, 'ia');
  } catch (e) {
    var el2 = document.getElementById('row_' + loadId); if (el2) el2.remove();
    addMsg('Erro de conexão. Verifique se o servidor está ativo.', 'ia');
  }
  send.disabled = false; input.focus();

  /* quero retornar a pergunta rápida após a resposta */

  setTimeout(function () {
    document.getElementById('chatQuick').style.display = 'flex';
  }, 20);
}

function addMsg(texto, tipo) {
  var msgs = document.getElementById('chatMsgs');
  var row = document.createElement('div');
  row.className = 'msg-row' + (tipo === 'user' ? ' user' : '');
  var icon = document.createElement('div');
  icon.className = 'msg-icon ' + (tipo === 'user' ? 'usr-icon' : 'ia-icon');
  icon.innerHTML = tipo === 'user'
    ? 'EU'
    : '<img src="/img/assets/voice-bot.svg" class="chat-icon" alt="Bot">';
  var div = document.createElement('div');
  div.className = 'msg ' + tipo;
  div.textContent = texto;
  if (tipo === 'user') { row.appendChild(div); row.appendChild(icon); }
  else { row.appendChild(icon); row.appendChild(div); }
  msgs.appendChild(row); msgs.scrollTop = msgs.scrollHeight;
}

/* ── Resumo IA ─────────────────────────────── */
/*     async function gerarResumoIA(fabricantes, lojas, ranking, filtros) {
      var el = document.getElementById('resumoIA');
      var txt = document.getElementById('resumoIATexto');
      el.style.display = 'block'; el.classList.add('loading');
      txt.textContent = 'Gerando análise inteligente...';
      try {
        var d = await fetch('/api/ia/resumo-estoque', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fabricantes, lojas, ranking, filtros })
        }).then(function (r) { return r.json(); });
        el.classList.remove('loading');
        txt.textContent = d.resumo || 'Não foi possível gerar o resumo.';
      } catch (e) { el.classList.remove('loading'); txt.textContent = 'Erro ao gerar análise.'; }
    } */


/* ════════════════════════════════════════════════
   AUDITORIA — ESTOQUE GRADE / CÓDIGO BARRAS
════════════════════════════════════════════════ */
var auditoriaDados = [];

function dataHojeInput() {
  var hoje = new Date();
  return hoje.getFullYear() + '-' +
    String(hoje.getMonth() + 1).padStart(2, '0') + '-' +
    String(hoje.getDate()).padStart(2, '0');
}

async function buscarAuditoria() {
  var loja = document.getElementById('aLoja').value || 1;
  var data = document.getElementById('aData').value || dataHojeInput();
  var tbody = document.getElementById('tbodyAuditoria');
  var resumo = document.getElementById('auditoriaResumo');

  tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:24px"><div class="spinner"></div><br>Consultando auditoria...</td></tr>';
  resumo.textContent = 'Consultando dados no Firebird...';

  try {
    var p = new URLSearchParams();
    p.set('interno_est', loja);
    p.set('data', data);

    var d = await apiFetch('/api/auditoria/estoque-grade?' + p).then(function (r) { return r.json(); });

    if (d.erro) {
      tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--danger)">' + d.erro + '</td></tr>';
      resumo.textContent = 'Erro na consulta.';
      return;
    }

    auditoriaDados = d.auditoria || [];

    document.getElementById('aKpiItens').textContent = (d.total_itens || 0).toLocaleString('pt-BR');
    document.getElementById('aKpiSaldo').textContent = fmt(d.total_saldo || 0, 3) + ' g';
    document.getElementById('aKpiValor').textContent = 'R$ ' + fmt(d.total_valor || 0, 2);
    document.getElementById('aKpiData').textContent = data.split('-').reverse().join('/');

    resumo.textContent = (d.total_itens || 0).toLocaleString('pt-BR') + ' item(ns) encontrados na loja ' + loja + '.';
    renderTabelaAuditoria(auditoriaDados);

  } catch (e) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--danger)">Erro: ' + e.message + '</td></tr>';
    resumo.textContent = 'Falha ao consultar auditoria.';
  }
}

function renderTabelaAuditoria(dados) {
  var tbody = document.getElementById('tbodyAuditoria');

  if (!dados.length) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--text-3)">Nenhum item encontrado.</td></tr>';
    return;
  }

  tbody.innerHTML = dados.map(function (r) {
    return '<tr>' +
      '<td><strong>' + (r.CODIGO || '') + '</strong></td>' +
      '<td>' + (r.CODIGO_BARRAS || '') + '</td>' +
      '<td>' + (r.NOME || '') + '</td>' +
      '<td>' + (r.UNIDADE || '') + '</td>' +
      '<td>' + (r.GRADE || '') + '</td>' +
      '<td style="text-align:right" class="money">' + fmt(r.SD_ATUAL, 3) + '</td>' +
      '<td style="text-align:right">R$ ' + fmt(r.VL_COMPRA, 2) + '</td>' +
      '<td style="text-align:right" class="money">R$ ' + fmt(r.TOTAL_P, 2) + '</td>' +
    '</tr>';
  }).join('');
}

function filtrarAuditoria(q) {
  q = (q || '').toLowerCase();
  if (!q) {
    renderTabelaAuditoria(auditoriaDados);
    return;
  }

  var filtrado = auditoriaDados.filter(function (r) {
    return String(r.CODIGO || '').toLowerCase().includes(q) ||
      String(r.CODIGO_BARRAS || '').toLowerCase().includes(q) ||
      String(r.NOME || '').toLowerCase().includes(q) ||
      String(r.GRADE || '').toLowerCase().includes(q);
  });

  renderTabelaAuditoria(filtrado);
}

(function iniciarAuditoriaData() {
  setTimeout(function () {
    var el = document.getElementById('aData');
    if (el && !el.value) el.value = dataHojeInput();
  }, 100);
})();


/* ════════════════════════════════════════════════
   INIT
════════════════════════════════════════════════ */
ping();
carregarFiltros();
carregarTudo();
