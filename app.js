'use strict';

// ── Constants ──────────────────────────────────────────────────
const CAT_COLORS = {
  'Viajes':          '#3b82f6',
  'Restaurantes':    '#f59e0b',
  'Supermercado':    '#10b981',
  'Alimentacion':    '#22c55e',
  'Alimentación':    '#22c55e',
  'Hipoteca':        '#b45309',
  'Entretenimiento': '#8b5cf6',
  'Transporte':      '#06b6d4',
  'Gasolina':        '#f97316',
  'Ropa':            '#ec4899',
  'Servicios':       '#6366f1',
  'Pago de Tarjeta': '#64748b',
  'Otro':            '#94a3b8',
};

const CATEGORIES = Object.keys(CAT_COLORS).filter(c => c !== 'Alimentación');

const PAGE_SIZE = 25;

// ── Settings ───────────────────────────────────────────────────
const Settings = {
  getApiKey: () => localStorage.getItem('hf_api_key') || '',
  setApiKey: v  => localStorage.setItem('hf_api_key', v),
  getModel:  () => localStorage.getItem('hf_model') || 'claude-haiku-4-5-20251001',
  setModel:  v  => localStorage.setItem('hf_model', v),
  getEmergencyFund: () => parseFloat(localStorage.getItem('hf_emergency_fund') || '0'),
  setEmergencyFund: v  => localStorage.setItem('hf_emergency_fund', v),
};

// ── IndexedDB ──────────────────────────────────────────────────
const DB = {
  _db: null,

  init() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('HomeFinances_v1', 1);
      req.onupgradeneeded = ({ target: { result: db } }) => {
        if (!db.objectStoreNames.contains('transactions')) {
          db.createObjectStore('transactions', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('files')) {
          db.createObjectStore('files', { keyPath: 'id' });
        }
      };
      req.onsuccess = ({ target: { result } }) => { this._db = result; resolve(); };
      req.onerror   = () => reject(req.error);
    });
  },

  _store(name, mode) {
    return this._db.transaction(name, mode).objectStore(name);
  },

  put(store, data) {
    return new Promise((resolve, reject) => {
      const req = this._store(store, 'readwrite').put(data);
      req.onsuccess = () => resolve();
      req.onerror   = () => reject(req.error);
    });
  },

  getAll(store) {
    return new Promise((resolve, reject) => {
      const req = this._store(store, 'readonly').getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
  },

  delete(store, id) {
    return new Promise((resolve, reject) => {
      const req = this._store(store, 'readwrite').delete(id);
      req.onsuccess = () => resolve();
      req.onerror   = () => reject(req.error);
    });
  },

  clear(store) {
    return new Promise((resolve, reject) => {
      const req = this._store(store, 'readwrite').clear();
      req.onsuccess = () => resolve();
      req.onerror   = () => reject(req.error);
    });
  },
};

// ── PDF text extraction ────────────────────────────────────────
async function extractPDFText(file) {
  const buffer = await file.arrayBuffer();
  const pdf    = await pdfjsLib.getDocument({ data: buffer }).promise;
  let text = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page    = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map(item => item.str).join(' ') + '\n';
  }
  return { text, pdf };
}

// ── Render PDF page to base64 JPEG (for scanned PDFs) ─────────
async function renderPageToBase64(pdfPage) {
  const viewport = pdfPage.getViewport({ scale: 1.2 });
  const canvas   = document.createElement('canvas');
  canvas.width   = viewport.width;
  canvas.height  = viewport.height;
  await pdfPage.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  return canvas.toDataURL('image/jpeg', 0.75).split(',')[1];
}

// Recover individual transaction objects from truncated JSON
function extractPartialTransactions(raw) {
  const transactions = [];
  const matches = raw.match(/\{[^{}]+\}/g) || [];
  for (const m of matches) {
    try {
      const obj = JSON.parse(m);
      if (obj.id && obj.date && obj.amount !== undefined) transactions.push(obj);
    } catch (e) {}
  }
  return transactions;
}

// ── Claude Vision API (PDFs escaneados sin texto) ──────────────
async function parseWithClaudeVision(pdf, model, apiKey, onProgress = () => {}) {
  // Sonnet lee documentos escaneados mejor que Haiku
  const visionModel = model.includes('haiku') ? 'claude-sonnet-4-6' : model;
  const BATCH       = 10;
  const total       = pdf.numPages;
  const totalBatch  = Math.ceil(total / BATCH);
  let allTransactions = [];
  const batchErrors   = [];
  let pagesRendered   = 0;

  for (let start = 1; start <= total; start += BATCH) {
    const end        = Math.min(start + BATCH - 1, total);
    const batchIndex = Math.floor((start - 1) / BATCH);
    const content    = [];

    for (let p = start; p <= end; p++) {
      const pct = (pagesRendered / total) * 50;
      onProgress(pct, `Preparando pagina ${p} de ${total}...`);
      const page = await pdf.getPage(p);
      const b64  = await renderPageToBase64(page);
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } });
      pagesRendered++;
    }

    const claudePct = 50 + (batchIndex / totalBatch) * 45;
    onProgress(claudePct, `Analizando paginas ${start}-${end} de ${total} con Claude...`);

    content.push({
      type: 'text',
      text: `Eres un experto en estados de cuenta bancarios mexicanos, especialmente de Santander Mexico.

Analiza estas imagenes de un estado de cuenta y extrae TODOS los movimientos/transacciones que veas en las tablas.

Busca columnas con: fecha, descripcion/concepto, cargo, abono, saldo.
Incluye TODOS los cargos y abonos que aparezcan, incluyendo:
- Compras con tarjeta
- Pagos de servicios
- Transferencias SPEI
- Disposiciones de efectivo
- Pagos de tarjeta de credito
- Cobros automaticos (incluyendo pagos hipotecarios o de credito de vivienda — INFONAVIT, FOVISSSTE, bancos)
- Depositos y abonos

Para cada movimiento devuelve:
{
  "id": "tx_001",
  "date": "YYYY-MM-DD",
  "description": "descripcion o comercio tal como aparece",
  "category": "una de exactamente: Viajes, Restaurantes, Supermercado, Alimentacion, Hipoteca, Entretenimiento, Transporte, Gasolina, Ropa, Servicios, Pago de Tarjeta, Otro",
  "amount": numero (positivo si es cargo/gasto, negativo si es abono/deposito),
  "originalAmount": mismo numero que amount si es MXN,
  "originalCurrency": "MXN",
  "account": "Credito o Debito segun el tipo de cuenta",
  "bank": "Santander"
}

Si estas paginas son portada, resumen general o no tienen tabla de movimientos, devuelve [].
RESPONDE UNICAMENTE con el array JSON. Sin explicaciones, sin markdown.`,
    });

    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({ model: visionModel, max_tokens: 8096, messages: [{ role: 'user', content }] }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error?.message || `Error HTTP ${res.status}`);
      }

      const data  = await res.json();
      const raw   = data.content[0].text.trim();
      window._lastVisionResponse = raw;
      console.log(`Vision batch ${start}-${end} (${visionModel}) stop_reason=${data.stop_reason}:`, raw.substring(0, 500));
      if (data.stop_reason === 'max_tokens') {
        console.warn(`ADVERTENCIA: respuesta truncada en batch ${start}-${end}. Intentando extraer transacciones parciales.`);
      }

      const match = raw.match(/\[[\s\S]*\]/);
      if (match) {
        try {
          const batch = JSON.parse(match[0]);
          if (Array.isArray(batch)) allTransactions = allTransactions.concat(batch);
        } catch (e) {
          // JSON truncated mid-array — recover complete objects
          const partial = extractPartialTransactions(raw);
          console.warn(`JSON truncado batch ${start}-${end}, recuperadas ${partial.length} transacciones parciales`);
          allTransactions = allTransactions.concat(partial);
        }
      } else if (data.stop_reason === 'max_tokens') {
        // No closing bracket — response cut off; recover what we can
        const partial = extractPartialTransactions(raw);
        console.warn(`Respuesta truncada (max_tokens) batch ${start}-${end}, recuperadas ${partial.length} transacciones`);
        allTransactions = allTransactions.concat(partial);
      }

      const donePct = 50 + ((batchIndex + 1) / totalBatch) * 45;
      onProgress(donePct, `${allTransactions.length} transacciones encontradas (pag. ${end} de ${total})...`);

    } catch (err) {
      batchErrors.push(`Paginas ${start}-${end}: ${err.message}`);
      console.error(`Vision batch error:`, err);
    }
  }

  if (!allTransactions.length) {
    const lastResponse = window._lastVisionResponse || 'sin respuesta';
    const detail = batchErrors.length
      ? ` (${batchErrors.join('; ')})`
      : ` Claude respondio: "${lastResponse.substring(0, 120)}"`;
    throw new Error('No se encontraron transacciones' + detail);
  }
  return allTransactions;
}

// ── Claude API ─────────────────────────────────────────────────
async function parseWithClaude(pdfText, model, apiKey) {
  const prompt = `Eres un experto en analisis de estados de cuenta bancarios.

Extrae TODAS las transacciones del siguiente texto y devuelve un array JSON valido.

Para cada transaccion usa exactamente estos campos:
- id: string unico (ej: "tx_001")
- date: fecha en formato YYYY-MM-DD
- description: nombre del comercio limpio y legible
- category: EXACTAMENTE una de estas: Viajes, Restaurantes, Supermercado, Alimentacion, Hipoteca, Entretenimiento, Transporte, Gasolina, Ropa, Servicios, Pago de Tarjeta, Otro
- amount: monto en MXN (numero, positivo=gasto, negativo=pago o abono)
- originalAmount: monto en la moneda original (numero)
- originalCurrency: MXN, EUR, USD, CHF, GBP, etc.
- account: Credito o Debito
- bank: nombre del banco

Clasificacion:
- Hoteles, aerolineas, Airbnb, aeropuertos, autopistas internacionales = Viajes
- Restaurantes, cafes, bares, comida rapida = Restaurantes
- Walmart, Soriana, Chedraui, Costco, HEB, supermercados = Supermercado
- Panaderias, tiendas de abarrotes, comida local = Alimentacion
- Pagos hipotecarios o de credito de vivienda, INFONAVIT, FOVISSSTE, cobros automaticos recurrentes ligados a una hipoteca = Hipoteca
- Cines, museos, deportes, eventos, parques = Entretenimiento
- Uber, taxi, bus, metro, peaje, SANEF, CTS = Transporte
- Gasolineras, PEMEX, BP, Shell = Gasolina
- Ropa, zapatos, H&M, Zara, accesorios = Ropa
- Netflix, Spotify, Google, servicios digitales, suscripciones = Servicios
- Pagos de tarjeta, liquidacion de credito = Pago de Tarjeta
- Resto = Otro

RESPONDE SOLO con el array JSON. Sin texto adicional, sin markdown.

Texto del estado de cuenta:
${pdfText.substring(0, 14000)}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model,
      max_tokens: 8096,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `Error HTTP ${res.status}`);
  }

  const data = await res.json();
  const raw  = data.content[0].text.trim();
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) throw new Error('Claude no devolvio un JSON valido. Verifica que el PDF contenga texto seleccionable.');
  return JSON.parse(match[0]);
}

// ── Formatters ─────────────────────────────────────────────────
function fmtMXN(n) {
  return new Intl.NumberFormat('es-MX', {
    style: 'currency', currency: 'MXN', minimumFractionDigits: 2,
  }).format(n || 0);
}

function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  const months = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
  return `${d} ${months[+m - 1]} ${y}`;
}

function monthLabel(ym) {
  if (!ym) return '';
  const [y, m] = ym.split('-');
  const months = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
  return `${months[+m - 1]} ${y}`;
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ── Analysis helpers ───────────────────────────────────────────
function isIncome(t)  { return t.amount < 0 && t.category !== 'Pago de Tarjeta'; }
function isExpense(t) { return t.amount > 0 && t.category !== 'Pago de Tarjeta'; }

function monthlyTotals(tx) {
  const months = {};
  tx.forEach(t => {
    const m = t.date?.substring(0, 7);
    if (!m) return;
    if (!months[m]) months[m] = { income: 0, expense: 0 };
    if (isIncome(t))  months[m].income  += -t.amount;
    if (isExpense(t)) months[m].expense += t.amount;
  });
  return months;
}

function categoryMonthlyTotals(tx) {
  const data = {};
  tx.filter(isExpense).forEach(t => {
    const m = t.date?.substring(0, 7);
    if (!m) return;
    data[t.category] = data[t.category] || {};
    data[t.category][m] = (data[t.category][m] || 0) + t.amount;
  });
  return data;
}

function normalizeDesc(desc) {
  return (desc || '').toLowerCase().replace(/[0-9]+/g, '').replace(/\s+/g, ' ').trim();
}

function detectRecurring(tx) {
  const groups = {};
  tx.filter(isExpense).forEach(t => {
    const key = normalizeDesc(t.description);
    const m   = t.date?.substring(0, 7);
    if (!key || !m) return;
    groups[key] = groups[key] || { months: new Set(), amounts: [], description: t.description, category: t.category };
    groups[key].months.add(m);
    groups[key].amounts.push(t.amount);
  });
  return Object.values(groups)
    .filter(g => g.months.size >= 2)
    .map(g => ({
      description: g.description,
      category:    g.category,
      monthsCount: g.months.size,
      avgAmount:   g.amounts.reduce((a, b) => a + b, 0) / g.amounts.length,
    }))
    .sort((a, b) => b.monthsCount - a.monthsCount || b.avgAmount - a.avgAmount);
}

// ── Recommendations engine (reglas de finanzas personales) ─────
function generateRecommendations(m) {
  const recs = [];

  if (m.avgSavingsRate !== null) {
    const pct = Math.round(m.avgSavingsRate * 100);
    if (m.avgSavingsRate < 0.20) {
      recs.push({
        title: 'Aumenta tu tasa de ahorro',
        text: `Tu tasa de ahorro promedio es ${pct}%. La regla 50/30/20, popularizada por la exsenadora Elizabeth Warren, recomienda destinar al menos 20% de tus ingresos a ahorro o pago de deudas. Reducir gastos variables como Entretenimiento o Restaurantes suele ser el ajuste mas rapido para acercarte a ese objetivo.`,
      });
    } else {
      recs.push({
        title: 'Tasa de ahorro saludable',
        text: `Tu tasa de ahorro promedio es ${pct}%, por encima del 20% que sugiere la regla 50/30/20. Considera dirigir el excedente a inversion o retiro una vez cubierto tu fondo de emergencia.`,
      });
    }
  }

  if (m.emergencyFund > 0) {
    if (m.runwayMonths < 3) {
      recs.push({
        title: 'Fortalece tu fondo de emergencia',
        text: `Tu fondo actual cubre ${m.runwayMonths.toFixed(1)} meses de gasto promedio. La guia mas comun en finanzas personales (usada por planificadores certificados CFP) recomienda mantener entre 3 y 6 meses de gastos esenciales en una cuenta liquida antes de priorizar inversion.`,
      });
    } else {
      recs.push({
        title: 'Fondo de emergencia saludable',
        text: `Tu fondo cubre ${m.runwayMonths.toFixed(1)} meses de gasto, dentro del rango de 3 a 6 meses recomendado. Los excedentes mas alla de ese colchon suelen rendir mas en instrumentos de inversion que en efectivo.`,
      });
    }
  } else if (m.avgMonthlyExpense > 0) {
    recs.push({
      title: 'Define un fondo de emergencia',
      text: `Tu gasto promedio mensual es ${fmtMXN(m.avgMonthlyExpense)}. Se recomienda un fondo de emergencia de 3 a 6 meses de gasto (${fmtMXN(m.avgMonthlyExpense * 3)} - ${fmtMXN(m.avgMonthlyExpense * 6)}). Registra tu ahorro actual en Configuracion para ver tu avance aqui.`,
    });
  }

  const overspent = m.comparison.filter(c => c.avg > 0 && c.deltaPct > 25);
  if (overspent.length) {
    const top = overspent[0];
    recs.push({
      title: `Revisa tu gasto en ${top.category}`,
      text: `Este mes gastaste ${fmtMXN(top.current)} en ${top.category}, ${Math.round(top.deltaPct)}% mas que tu promedio historico (${fmtMXN(top.avg)}). Detectar desviaciones frente a tu propio promedio es la base del seguimiento de presupuesto que recomienda la mayoria de metodologias de finanzas personales.`,
    });
  }

  if (m.recurringMonthly > 0) {
    recs.push({
      title: 'Audita tus cargos recurrentes',
      text: `Detectamos aproximadamente ${fmtMXN(m.recurringMonthly)} mensuales en cargos que se repiten mes a mes (suscripciones, servicios). Revisar periodicamente estos cargos es una recomendacion comun para reducir el "gasto hormiga" que erosiona el ahorro sin que se note dia a dia.`,
    });
  }

  if (!recs.length) {
    recs.push({
      title: 'Sigue registrando tus movimientos',
      text: 'Con mas meses de historial podremos calcular tu tasa de ahorro, fondo de emergencia recomendado y patrones de gasto con mayor precision.',
    });
  }

  return recs;
}

// ── Toast ──────────────────────────────────────────────────────
let _toastTimer;
function toast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className   = `toast${type ? ' ' + type : ''}`;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { el.className = 'toast hidden'; }, 3600);
}

// ── Navigation ─────────────────────────────────────────────────
function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById(`view-${name}`)?.classList.remove('hidden');
  document.querySelector(`[data-view="${name}"]`)?.classList.add('active');

  if (name === 'dashboard')    renderDashboard();
  if (name === 'upload')       renderFiles();
  if (name === 'transactions') renderTransactions();
  if (name === 'analysis')     renderAnalysis();
  if (name === 'settings')     renderSettings();
}

// ── Charts ─────────────────────────────────────────────────────
const _charts = {};

function destroyChart(k) { if (_charts[k]) { _charts[k].destroy(); delete _charts[k]; } }

function renderCategoryChart(tx) {
  destroyChart('cat');
  const expenses = tx.filter(t => t.amount > 0 && t.category !== 'Pago de Tarjeta');
  const totals   = {};
  expenses.forEach(t => { totals[t.category] = (totals[t.category] || 0) + t.amount; });

  const sorted = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  const labels = sorted.map(([k]) => k);
  const data   = sorted.map(([, v]) => +v.toFixed(2));
  const colors = labels.map(l => CAT_COLORS[l] || '#94a3b8');

  const ctx = document.getElementById('chartCategory');
  if (!ctx) return;

  const total = data.reduce((a, b) => a + b, 0);
  _charts.cat = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{ data, backgroundColor: colors, borderWidth: 2, borderColor: '#fff' }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'right', labels: { boxWidth: 12, font: { size: 11 }, padding: 10 } },
        tooltip: {
          callbacks: {
            label: c => ` ${c.label}: ${fmtMXN(c.raw)} (${Math.round(c.raw / total * 100)}%)`,
          },
        },
      },
    },
  });
}

function renderMonthlyChart(tx) {
  destroyChart('monthly');
  const expenses = tx.filter(t => t.amount > 0 && t.category !== 'Pago de Tarjeta');
  const totals   = {};
  expenses.forEach(t => {
    const k = t.date ? t.date.substring(0, 7) : '0000-00';
    totals[k] = (totals[k] || 0) + t.amount;
  });

  const sorted = Object.entries(totals).sort(([a], [b]) => a.localeCompare(b));
  const labels = sorted.map(([k]) => monthLabel(k));
  const data   = sorted.map(([, v]) => +v.toFixed(2));

  const ctx = document.getElementById('chartMonthly');
  if (!ctx) return;

  _charts.monthly = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Gastos MXN',
        data,
        backgroundColor: '#6366f1',
        borderRadius: 5,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        y: {
          beginAtZero: true,
          ticks: { callback: v => '$' + (v >= 1000 ? (v / 1000).toFixed(0) + 'k' : v) },
        },
      },
    },
  });
}

function renderIncomeExpenseChart(monthsList, totals) {
  destroyChart('incomeExpense');
  const labels  = monthsList.map(monthLabel);
  const income  = monthsList.map(m => +totals[m].income.toFixed(2));
  const expense = monthsList.map(m => +totals[m].expense.toFixed(2));

  const ctx = document.getElementById('chartIncomeExpense');
  if (!ctx) return;

  _charts.incomeExpense = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Ingresos', data: income,  backgroundColor: '#10b981', borderRadius: 5 },
        { label: 'Gastos',   data: expense, backgroundColor: '#ef4444', borderRadius: 5 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { position: 'top', labels: { boxWidth: 12, font: { size: 11 } } } },
      scales: {
        y: { beginAtZero: true, ticks: { callback: v => '$' + (v >= 1000 ? (v / 1000).toFixed(0) + 'k' : v) } },
      },
    },
  });
}

function renderCategoryTrendChart(monthsList, catMonthly) {
  destroyChart('catTrend');
  const totals  = Object.entries(catMonthly).map(([cat, byMonth]) => [cat, Object.values(byMonth).reduce((a, b) => a + b, 0)]);
  const topCats = totals.sort((a, b) => b[1] - a[1]).slice(0, 6).map(([cat]) => cat);

  const labels   = monthsList.map(monthLabel);
  const datasets = topCats.map(cat => ({
    label: cat,
    data: monthsList.map(m => +((catMonthly[cat]?.[m]) || 0).toFixed(2)),
    borderColor: CAT_COLORS[cat] || '#94a3b8',
    backgroundColor: 'transparent',
    tension: .3,
    borderWidth: 2,
    pointRadius: 2,
  }));

  const ctx = document.getElementById('chartCategoryTrend');
  if (!ctx) return;

  _charts.catTrend = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { position: 'top', labels: { boxWidth: 10, font: { size: 10 } } } },
      scales: {
        y: { beginAtZero: true, ticks: { callback: v => '$' + (v >= 1000 ? (v / 1000).toFixed(0) + 'k' : v) } },
      },
    },
  });
}

// ── Analisis ───────────────────────────────────────────────────
async function renderAnalysis() {
  const allTx = await DB.getAll('transactions');

  if (!allTx.length) {
    document.getElementById('analysisStats').innerHTML = '';
    document.getElementById('comparisonList').innerHTML     = '<p class="empty">Sube estados de cuenta para ver tu analisis aqui.</p>';
    document.getElementById('recurringList').innerHTML      = '';
    document.getElementById('recommendationsList').innerHTML = '';
    destroyChart('incomeExpense');
    destroyChart('catTrend');
    return;
  }

  const totals       = monthlyTotals(allTx);
  const sortedMonths = Object.keys(totals).sort();

  const ratesValid = sortedMonths
    .map(m => totals[m])
    .filter(d => d.income > 0)
    .map(d => (d.income - d.expense) / d.income);
  const avgSavingsRate = ratesValid.length ? ratesValid.reduce((a, b) => a + b, 0) / ratesValid.length : null;

  const recentMonths     = sortedMonths.slice(-6);
  const avgMonthlyExpense = recentMonths.length
    ? recentMonths.reduce((s, m) => s + totals[m].expense, 0) / recentMonths.length
    : 0;

  const emergencyFund = Settings.getEmergencyFund();
  const runwayMonths   = avgMonthlyExpense > 0 ? emergencyFund / avgMonthlyExpense : 0;

  const recurring        = detectRecurring(allTx);
  const recurringMonthly = recurring.reduce((s, r) => s + r.avgAmount, 0);

  const catMonthly  = categoryMonthlyTotals(allTx);
  const lastMonth   = sortedMonths[sortedMonths.length - 1];
  const priorMonths = sortedMonths.slice(0, -1);
  const comparison = Object.entries(catMonthly).map(([cat, byMonth]) => {
    const current   = byMonth[lastMonth] || 0;
    const priorVals = priorMonths.map(m => byMonth[m] || 0).filter(v => v > 0);
    const avg       = priorVals.length ? priorVals.reduce((a, b) => a + b, 0) / priorVals.length : 0;
    const deltaPct  = avg > 0 ? ((current - avg) / avg * 100) : (current > 0 ? 100 : 0);
    return { category: cat, current, avg, deltaPct };
  }).filter(c => c.current > 0 || c.avg > 0)
    .sort((a, b) => b.current - a.current);

  document.getElementById('analysisSubtitle').textContent = `${sortedMonths.length} meses de historial`;
  document.getElementById('analysisStats').innerHTML = `
    <div class="stat-card">
      <p class="stat-label">Tasa de Ahorro Promedio</p>
      <p class="stat-value">${avgSavingsRate !== null ? Math.round(avgSavingsRate * 100) + '%' : '—'}</p>
      <p class="stat-sub">Meta sugerida: 20%</p>
    </div>
    <div class="stat-card">
      <p class="stat-label">Fondo de Emergencia</p>
      <p class="stat-value">${emergencyFund > 0 ? runwayMonths.toFixed(1) + ' meses' : 'Sin registrar'}</p>
      <p class="stat-sub">Recomendado: 3-6 meses</p>
    </div>
    <div class="stat-card">
      <p class="stat-label">Gasto Recurrente Mensual</p>
      <p class="stat-value">${fmtMXN(recurringMonthly)}</p>
      <p class="stat-sub">${recurring.length} cargo${recurring.length !== 1 ? 's' : ''} detectado${recurring.length !== 1 ? 's' : ''}</p>
    </div>
    <div class="stat-card">
      <p class="stat-label">Gasto Promedio Mensual</p>
      <p class="stat-value">${fmtMXN(avgMonthlyExpense)}</p>
      <p class="stat-sub">Ultimos ${recentMonths.length} meses</p>
    </div>
  `;

  renderIncomeExpenseChart(sortedMonths, totals);
  renderCategoryTrendChart(sortedMonths, catMonthly);

  const compEl  = document.getElementById('comparisonList');
  const compTop = comparison.slice(0, 8);
  if (!compTop.length) {
    compEl.innerHTML = '<p class="empty">Necesitas al menos dos meses de historial para comparar.</p>';
  } else {
    compEl.innerHTML = compTop.map(c => {
      const color    = CAT_COLORS[c.category] || '#94a3b8';
      const dirClass = c.deltaPct > 5 ? 'up' : c.deltaPct < -5 ? 'down' : 'flat';
      const sign     = c.deltaPct > 0 ? '+' : '';
      return `
        <div class="comparison-row">
          <div class="comparison-left">
            <span class="cat-badge" style="background:${color}1a;color:${color}">${esc(c.category)}</span>
          </div>
          <div class="comparison-amounts">${fmtMXN(c.current)} vs prom. ${fmtMXN(c.avg)}</div>
          <span class="comparison-delta ${dirClass}">${sign}${Math.round(c.deltaPct)}%</span>
        </div>
      `;
    }).join('');
  }

  const recEl  = document.getElementById('recurringList');
  const recTop = recurring.slice(0, 8);
  if (!recTop.length) {
    recEl.innerHTML = '<p class="empty">No detectamos cargos recurrentes con al menos dos meses de historial.</p>';
  } else {
    recEl.innerHTML = recTop.map(r => `
      <div class="recurring-row">
        <div>
          <p class="recurring-desc">${esc(r.description)}</p>
          <p class="recurring-meta">${esc(r.category)} &bull; ${r.monthsCount} meses</p>
        </div>
        <span class="recurring-amount">${fmtMXN(r.avgAmount)} /mes</span>
      </div>
    `).join('');
  }

  const recs = generateRecommendations({ avgSavingsRate, emergencyFund, runwayMonths, avgMonthlyExpense, comparison, recurringMonthly });
  document.getElementById('recommendationsList').innerHTML = recs.map(r => `
    <div class="rec-item">
      <p class="rec-title">${esc(r.title)}</p>
      <p class="rec-text">${esc(r.text)}</p>
    </div>
  `).join('');
}

// ── Dashboard ──────────────────────────────────────────────────
async function renderDashboard() {
  const allTx = await DB.getAll('transactions');

  // Populate period selector
  const sel    = document.getElementById('dashPeriod');
  const months = [...new Set(allTx.map(t => t.date?.substring(0, 7)).filter(Boolean))].sort().reverse();
  const existing = [...sel.options].map(o => o.value);
  months.forEach(m => {
    if (!existing.includes(m)) sel.add(new Option(monthLabel(m), m), 1);
  });

  const period = sel.value;
  const tx     = period === 'all' ? allTx : allTx.filter(t => t.date?.startsWith(period));

  document.getElementById('dashSubtitle').textContent =
    period === 'all'
      ? `${allTx.length} transacciones en total`
      : `${tx.length} transacciones — ${monthLabel(period)}`;

  const expenses  = tx.filter(t => t.amount > 0 && t.category !== 'Pago de Tarjeta');
  const total     = expenses.reduce((s, t) => s + t.amount, 0);
  const catTotals = {};
  expenses.forEach(t => { catTotals[t.category] = (catTotals[t.category] || 0) + t.amount; });
  const topCat = Object.entries(catTotals).sort((a, b) => b[1] - a[1])[0];
  const avg    = expenses.length > 0 ? total / expenses.length : 0;

  document.getElementById('statsGrid').innerHTML = `
    <div class="stat-card">
      <p class="stat-label">Total Gastos</p>
      <p class="stat-value">${fmtMXN(total)}</p>
      <p class="stat-sub">${expenses.length} transacciones</p>
    </div>
    <div class="stat-card">
      <p class="stat-label">Mayor Categoria</p>
      <p class="stat-value" style="font-size:1.1rem">${topCat ? topCat[0] : '—'}</p>
      <p class="stat-sub">${topCat ? fmtMXN(topCat[1]) : 'Sin datos'}</p>
    </div>
    <div class="stat-card">
      <p class="stat-label">Total Mov.</p>
      <p class="stat-value">${tx.length}</p>
      <p class="stat-sub">${expenses.length} gastos</p>
    </div>
    <div class="stat-card">
      <p class="stat-label">Promedio / gasto</p>
      <p class="stat-value">${fmtMXN(avg)}</p>
      <p class="stat-sub">por transaccion</p>
    </div>
  `;

  renderCategoryChart(tx);
  renderMonthlyChart(tx);

  const recent = [...allTx]
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
    .slice(0, 10);

  const el = document.getElementById('recentList');
  if (!recent.length) {
    el.innerHTML = '<p class="empty">Sube un estado de cuenta para ver tus transacciones aqui.</p>';
    return;
  }

  el.innerHTML = recent.map(t => {
    const color = CAT_COLORS[t.category] || '#94a3b8';
    return `
      <div class="recent-item">
        <div class="recent-left">
          <span class="recent-date">${fmtDate(t.date)}</span>
          <span class="recent-desc">${esc(t.description)}</span>
          <span class="cat-badge" style="background:${color}1a;color:${color}">${esc(t.category)}</span>
        </div>
        <span class="recent-amount${t.amount < 0 ? ' credit' : ''}">${fmtMXN(t.amount)}</span>
      </div>
    `;
  }).join('');
}

// ── Transactions ───────────────────────────────────────────────
const txState = { page: 1, search: '', month: 'all', category: 'all' };

async function renderTransactions() {
  const allTx = await DB.getAll('transactions');
  const months = [...new Set(allTx.map(t => t.date?.substring(0, 7)).filter(Boolean))].sort().reverse();
  const sel    = document.getElementById('txMonth');
  const existing = [...sel.options].map(o => o.value);
  months.forEach(m => {
    if (!existing.includes(m)) sel.add(new Option(monthLabel(m), m));
  });
  applyTxFilters(allTx);
}

function applyTxFilters(allTx) {
  const q = txState.search.toLowerCase();
  const filtered = allTx.filter(t => {
    if (txState.month !== 'all' && !t.date?.startsWith(txState.month)) return false;
    if (txState.category !== 'all' && t.category !== txState.category) return false;
    if (q && !t.description?.toLowerCase().includes(q)) return false;
    return true;
  }).sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  const total = filtered.length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  txState.page = Math.min(txState.page, pages);

  const page = filtered.slice((txState.page - 1) * PAGE_SIZE, txState.page * PAGE_SIZE);

  document.getElementById('txSubtitle').textContent  = `${total} transacciones`;
  document.getElementById('txCountLabel').textContent = `Mostrando ${page.length} de ${total}`;

  const body = document.getElementById('txBody');
  if (!page.length) {
    body.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:40px;color:#94a3b8">Sin resultados</td></tr>`;
  } else {
    body.innerHTML = page.map(t => {
      const color = CAT_COLORS[t.category] || '#94a3b8';
      const origFmt = t.originalAmount != null
        ? `${t.originalCurrency || ''} ${(+t.originalAmount).toLocaleString('es-MX', { minimumFractionDigits: 2 })}`
        : '';
      return `
        <tr>
          <td style="white-space:nowrap">${fmtDate(t.date)}</td>
          <td>${esc(t.description || '')}</td>
          <td>
            <select class="cat-edit" data-id="${esc(t.id)}" style="background-color:${color}1a;color:${color}">
              ${CATEGORIES.map(c => `<option value="${esc(c)}"${c === t.category ? ' selected' : ''}>${esc(c)}</option>`).join('')}
            </select>
          </td>
          <td>${esc(t.originalCurrency || '')}</td>
          <td class="right">${origFmt}</td>
          <td class="right ${t.amount < 0 ? 'amount-neg' : 'amount-pos'}">${fmtMXN(t.amount)}</td>
          <td>${esc(t.account || '')}</td>
          <td>${esc(t.bank || '')}</td>
        </tr>
      `;
    }).join('');

    body.querySelectorAll('.cat-edit').forEach(sel => {
      sel.addEventListener('change', async () => {
        const id = sel.dataset.id;
        const tx = (await DB.getAll('transactions')).find(t => t.id === id);
        if (!tx) return;
        tx.category = sel.value;
        await DB.put('transactions', tx);
        const color = CAT_COLORS[tx.category] || '#94a3b8';
        sel.style.backgroundColor = `${color}1a`;
        sel.style.color = color;
        toast('Categoria actualizada', 'success');
      });
    });
  }

  // Pagination
  const pag = document.getElementById('pagination');
  if (pages <= 1) { pag.innerHTML = ''; return; }

  let html = '';
  if (txState.page > 1) html += `<button class="page-btn" data-p="${txState.page - 1}">&lsaquo;</button>`;

  const start = Math.max(1, txState.page - 3);
  const end   = Math.min(pages, txState.page + 3);
  for (let i = start; i <= end; i++) {
    html += `<button class="page-btn${i === txState.page ? ' active' : ''}" data-p="${i}">${i}</button>`;
  }
  if (txState.page < pages) html += `<button class="page-btn" data-p="${txState.page + 1}">&rsaquo;</button>`;

  pag.innerHTML = html;
  pag.querySelectorAll('.page-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      txState.page = +btn.dataset.p;
      applyTxFilters(await DB.getAll('transactions'));
    });
  });
}

// ── Upload ─────────────────────────────────────────────────────
async function renderFiles() {
  const files  = await DB.getAll('files');
  const list   = document.getElementById('filesList');
  if (!files.length) {
    list.innerHTML = '<p class="empty">No hay archivos procesados aun.</p>';
    return;
  }

  const sorted = [...files].sort((a, b) => (b.uploadedAt || '').localeCompare(a.uploadedAt || ''));
  list.innerHTML = sorted.map(f => `
    <div class="file-item">
      <div>
        <p class="file-name">${esc(f.name)}</p>
        <p class="file-meta">${f.txCount} transacciones &bull; ${f.uploadedAt ? new Date(f.uploadedAt).toLocaleDateString('es-MX') : ''}</p>
      </div>
      <div class="file-actions">
        <span class="badge badge--success">Procesado</span>
        <button class="btn btn--sm btn--outline" data-del="${esc(f.id)}">Eliminar</button>
      </div>
    </div>
  `).join('');

  list.querySelectorAll('[data-del]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Eliminar este archivo y todas sus transacciones?')) return;
      const fid   = btn.dataset.del;
      const allTx = await DB.getAll('transactions');
      for (const t of allTx.filter(t => t.fileId === fid)) await DB.delete('transactions', t.id);
      await DB.delete('files', fid);
      toast('Archivo eliminado', 'success');
      renderFiles();
    });
  });
}

async function processFilesSequentially(files) {
  const apiKey = Settings.getApiKey();
  if (!apiKey) {
    toast('Configura tu API Key en Configuracion primero', 'error');
    showView('settings');
    return;
  }

  const uploadCard = document.getElementById('uploadCard');
  const procCard   = document.getElementById('processingCard');
  const titleEl    = document.getElementById('processingTitle');
  const hintEl     = document.getElementById('processingHint');
  const fill       = document.getElementById('progressFill');

  uploadCard.classList.add('hidden');
  procCard.classList.remove('hidden');

  let totalImported = 0;
  const errors = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const base = (i / files.length) * 100;
    const slot = 100 / files.length;

    const setProgress = (pct, hint) => {
      fill.style.width = (base + pct * slot / 100) + '%';
      hintEl.textContent = hint;
    };

    titleEl.textContent = files.length > 1
      ? `Archivo ${i + 1} de ${files.length}: ${file.name}`
      : `Procesando: ${file.name}`;

    try {
      setProgress(10, 'Extrayendo texto del PDF...');
      const { text, pdf } = await extractPDFText(file);
      const hasText = text.trim().length > 100;

      let transactions;
      if (hasText) {
        setProgress(40, 'Enviando a Claude para clasificar transacciones...');
        transactions = await parseWithClaude(text, Settings.getModel(), apiKey);
      } else {
        const visionCb = (pct, hint) => setProgress(15 + pct * 0.75, hint);
        visionCb(0, `PDF escaneado (${pdf.numPages} pags.) — preparando imagenes...`);
        transactions = await parseWithClaudeVision(pdf, Settings.getModel(), apiKey, visionCb);
      }
      if (!Array.isArray(transactions) || !transactions.length) {
        throw new Error('Claude no encontro transacciones en este PDF.');
      }

      setProgress(75, `Guardando ${transactions.length} transacciones...`);

      const fileId = uid();
      const now    = new Date().toISOString();

      for (let j = 0; j < transactions.length; j++) {
        const t = transactions[j];
        await DB.put('transactions', {
          id:               `${fileId}_${j}`,
          date:             t.date || '',
          description:      t.description || '',
          category:         t.category || 'Otro',
          amount:           +parseFloat(t.amount || 0).toFixed(2),
          originalAmount:   +parseFloat(t.originalAmount || t.amount || 0).toFixed(2),
          originalCurrency: t.originalCurrency || 'MXN',
          account:          t.account || '',
          bank:             t.bank || '',
          fileId,
          createdAt: now,
        });
      }

      await DB.put('files', { id: fileId, name: file.name, txCount: transactions.length, uploadedAt: now });
      totalImported += transactions.length;
      setProgress(100, `Listo: ${transactions.length} transacciones`);

    } catch (err) {
      errors.push(`${file.name}: ${err.message}`);
      console.error(err);
    }
  }

  fill.style.width = '100%';

  if (errors.length === 0) {
    toast(`${totalImported} transacciones importadas de ${files.length} archivo${files.length > 1 ? 's' : ''}`, 'success');
  } else if (totalImported > 0) {
    toast(`${totalImported} transacciones importadas. ${errors.length} archivo${errors.length > 1 ? 's' : ''} con error.`, '');
  } else {
    toast('Error: ' + errors[0], 'error');
  }

  setTimeout(() => {
    procCard.classList.add('hidden');
    uploadCard.classList.remove('hidden');
    fill.style.width = '0%';
    renderFiles();
  }, 1500);
}

// ── Settings ───────────────────────────────────────────────────
async function renderSettings() {
  const key = Settings.getApiKey();
  document.getElementById('apiKeyInput').value  = key ? '••••••••••••••••••••' : '';
  document.getElementById('modelSelect').value  = Settings.getModel();
  const fund = Settings.getEmergencyFund();
  document.getElementById('emergencyFundInput').value = fund || '';
  const allTx    = await DB.getAll('transactions');
  const allFiles = await DB.getAll('files');
  document.getElementById('storedTxCount').textContent   = allTx.length;
  document.getElementById('storedFileCount').textContent = allFiles.length;
}

function updateApiStatus() {
  const ok  = !!Settings.getApiKey();
  const dot = document.getElementById('statusDot');
  const lbl = document.getElementById('statusLabel');
  dot.className   = ok ? 'status-dot ok' : 'status-dot';
  lbl.textContent = ok ? 'API configurada' : 'API no configurada';
}

// ── CSV Export ─────────────────────────────────────────────────
function exportCSV(rows) {
  const header = ['Fecha','Descripcion','Categoria','Moneda','Monto Original','Monto (MXN)','Cuenta','Banco'];
  const lines  = rows.map(t => [
    t.date, t.description, t.category, t.originalCurrency,
    t.originalAmount, t.amount, t.account, t.bank,
  ].map(v => `"${String(v ?? '').replace(/"/g, '""')}"`));

  const csv  = '﻿' + [header.map(h => `"${h}"`), ...lines].map(r => r.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  Object.assign(document.createElement('a'), { href: url, download: 'transacciones.csv' }).click();
  URL.revokeObjectURL(url);
}

// ── XSS helper ─────────────────────────────────────────────────
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Init ───────────────────────────────────────────────────────
async function init() {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

  await DB.init();
  updateApiStatus();

  // Sidebar navigation
  document.querySelectorAll('[data-view]').forEach(el => {
    el.addEventListener('click', () => showView(el.dataset.view));
  });

  // Dashboard period
  document.getElementById('dashPeriod').addEventListener('change', renderDashboard);

  // Upload zone
  const zone      = document.getElementById('uploadZone');
  const fileInput = document.getElementById('fileInput');

  document.getElementById('selectFileBtn').addEventListener('click', e => {
    e.stopPropagation();
    fileInput.click();
  });
  zone.addEventListener('click', () => fileInput.click());

  zone.addEventListener('dragover',  e => { e.preventDefault(); zone.classList.add('dragover'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('dragover');
    const files = [...e.dataTransfer.files].filter(f => f.type === 'application/pdf');
    if (files.length) processFilesSequentially(files);
    else toast('Solo se aceptan archivos PDF', 'error');
  });

  fileInput.addEventListener('change', () => {
    const files = [...fileInput.files].filter(f => f.type === 'application/pdf');
    if (files.length) processFilesSequentially(files);
    fileInput.value = '';
  });

  // Transaction filters
  let filterTimer;
  document.getElementById('txSearch').addEventListener('input', e => {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(async () => {
      txState.search = e.target.value;
      txState.page   = 1;
      applyTxFilters(await DB.getAll('transactions'));
    }, 280);
  });

  document.getElementById('txMonth').addEventListener('change', async e => {
    txState.month = e.target.value;
    txState.page  = 1;
    applyTxFilters(await DB.getAll('transactions'));
  });

  document.getElementById('txCategory').addEventListener('change', async e => {
    txState.category = e.target.value;
    txState.page     = 1;
    applyTxFilters(await DB.getAll('transactions'));
  });

  // Export (transactions view)
  document.getElementById('exportBtn').addEventListener('click', async () => {
    const all = await DB.getAll('transactions');
    if (!all.length) return toast('No hay transacciones para exportar', 'error');
    exportCSV(all);
    toast(`${all.length} transacciones exportadas`, 'success');
  });

  // Settings — save API key
  document.getElementById('saveApiKeyBtn').addEventListener('click', () => {
    const val = document.getElementById('apiKeyInput').value.trim();
    if (!val || val.startsWith('•')) return toast('Ingresa una API Key valida', 'error');
    Settings.setApiKey(val);
    document.getElementById('apiKeyInput').value = '••••••••••••••••••••';
    updateApiStatus();
    toast('API Key guardada correctamente', 'success');
  });

  document.getElementById('modelSelect').addEventListener('change', e => {
    Settings.setModel(e.target.value);
    toast('Modelo actualizado', 'success');
  });

  document.getElementById('saveEmergencyFundBtn').addEventListener('click', () => {
    const val = parseFloat(document.getElementById('emergencyFundInput').value) || 0;
    Settings.setEmergencyFund(val);
    toast('Fondo de emergencia actualizado', 'success');
  });

  // Settings — export all
  document.getElementById('exportAllBtn').addEventListener('click', async () => {
    const all = await DB.getAll('transactions');
    if (!all.length) return toast('No hay transacciones aun', 'error');
    exportCSV(all);
    toast(`${all.length} transacciones exportadas`, 'success');
  });

  // Settings — clear all data
  document.getElementById('clearDataBtn').addEventListener('click', async () => {
    if (!confirm('Borrar TODOS los datos? Esta accion no se puede deshacer.')) return;
    await DB.clear('transactions');
    await DB.clear('files');
    toast('Todos los datos han sido borrados', 'success');
    renderSettings();
  });

  // Initial render
  renderDashboard();
}

init().catch(console.error);
