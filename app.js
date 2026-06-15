'use strict';

// ── Constants ──────────────────────────────────────────────────
const CAT_COLORS = {
  'Viajes':          '#3b82f6',
  'Restaurantes':    '#f59e0b',
  'Supermercado':    '#10b981',
  'Alimentacion':    '#22c55e',
  'Alimentación':    '#22c55e',
  'Entretenimiento': '#8b5cf6',
  'Transporte':      '#06b6d4',
  'Gasolina':        '#f97316',
  'Ropa':            '#ec4899',
  'Servicios':       '#6366f1',
  'Pago de Tarjeta': '#64748b',
  'Otro':            '#94a3b8',
};

const PAGE_SIZE = 25;

// ── Settings ───────────────────────────────────────────────────
const Settings = {
  getApiKey: () => localStorage.getItem('hf_api_key') || '',
  setApiKey: v  => localStorage.setItem('hf_api_key', v),
  getModel:  () => localStorage.getItem('hf_model') || 'claude-haiku-4-5-20251001',
  setModel:  v  => localStorage.setItem('hf_model', v),
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
  const viewport = pdfPage.getViewport({ scale: 2.0 });
  const canvas   = document.createElement('canvas');
  canvas.width   = viewport.width;
  canvas.height  = viewport.height;
  await pdfPage.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  return canvas.toDataURL('image/jpeg', 0.88).split(',')[1];
}

// ── Claude Vision API (PDFs escaneados sin texto) ──────────────
async function parseWithClaudeVision(pdf, model, apiKey) {
  const BATCH = 5;
  const total = pdf.numPages;
  let allTransactions = [];
  const batchErrors = [];

  for (let start = 1; start <= total; start += BATCH) {
    const end     = Math.min(start + BATCH - 1, total);
    const content = [];

    for (let p = start; p <= end; p++) {
      const page = await pdf.getPage(p);
      const b64  = await renderPageToBase64(page);
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } });
    }

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
- Cobros automaticos
- Depositos y abonos

Para cada movimiento devuelve:
{
  "id": "tx_001",
  "date": "YYYY-MM-DD",
  "description": "descripcion o comercio tal como aparece",
  "category": "una de exactamente: Viajes, Restaurantes, Supermercado, Alimentacion, Entretenimiento, Transporte, Gasolina, Ropa, Servicios, Pago de Tarjeta, Otro",
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
        body: JSON.stringify({ model, max_tokens: 8096, messages: [{ role: 'user', content }] }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error?.message || `Error HTTP ${res.status}`);
      }

      const data  = await res.json();
      const raw   = data.content[0].text.trim();
      console.log(`Vision batch ${start}-${end}:`, raw.substring(0, 200));

      const match = raw.match(/\[[\s\S]*\]/);
      if (match) {
        try {
          const batch = JSON.parse(match[0]);
          if (Array.isArray(batch)) allTransactions = allTransactions.concat(batch);
        } catch (e) { batchErrors.push(`Paginas ${start}-${end}: JSON invalido`); }
      }
    } catch (err) {
      batchErrors.push(`Paginas ${start}-${end}: ${err.message}`);
      console.error(`Vision batch error:`, err);
    }
  }

  if (!allTransactions.length) {
    const detail = batchErrors.length
      ? ` (${batchErrors.join('; ')})`
      : ' — revisa la consola del navegador para ver la respuesta de Claude.';
    throw new Error('No se encontraron transacciones en el PDF' + detail);
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
- category: EXACTAMENTE una de estas: Viajes, Restaurantes, Supermercado, Alimentacion, Entretenimiento, Transporte, Gasolina, Ropa, Servicios, Pago de Tarjeta, Otro
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
          <td><span class="cat-badge" style="background:${color}1a;color:${color}">${esc(t.category || '')}</span></td>
          <td>${esc(t.originalCurrency || '')}</td>
          <td class="right">${origFmt}</td>
          <td class="right ${t.amount < 0 ? 'amount-neg' : 'amount-pos'}">${fmtMXN(t.amount)}</td>
          <td>${esc(t.account || '')}</td>
          <td>${esc(t.bank || '')}</td>
        </tr>
      `;
    }).join('');
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
        setProgress(20, `PDF escaneado detectado — leyendo ${pdf.numPages} paginas con vision IA...`);
        transactions = await parseWithClaudeVision(pdf, Settings.getModel(), apiKey);
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
