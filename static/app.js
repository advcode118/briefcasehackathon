/* Proven — shared helpers + dashboard.
 * Plain JS, no build. Money from the API is integer pence. */

// ---------------------------------------------------------------- shared --

const MOCK = new URLSearchParams(location.search).has('mock');

function withMock(path) {
  return MOCK ? path + (path.includes('?') ? '&' : '?') + 'mock=1' : path;
}

async function api(method, path, body) {
  if (MOCK && window.MockAPI) return window.MockAPI.handle(method, path, body);
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(path, opts);
  if (!r.ok) {
    let msg = r.statusText;
    try {
      const j = await r.json();
      msg = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail || j);
    } catch (_) { /* keep statusText */ }
    throw new Error(`${r.status} ${msg}`);
  }
  return r.json();
}

function fmtGBP(pence) {
  if (pence === null || pence === undefined || isNaN(pence)) return '—';
  const neg = pence < 0;
  const abs = Math.abs(Math.round(pence));
  const pounds = Math.floor(abs / 100);
  const p = abs % 100;
  const s = '£' + pounds.toLocaleString('en-GB') + (p ? '.' + String(p).padStart(2, '0') : '');
  return neg ? '−' + s : s;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return esc(iso);
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

const DECISION_COLOR = { allow: '#10b981', escrow: '#3b82f6', hold: '#f59e0b', block: '#ef4444' };
const DECISION_LABEL = { allow: 'Allow', escrow: 'Escrow', hold: 'Hold', block: 'Block', approval: 'Approval' };

const DECISION_CHIP = {
  allow: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  escrow: 'bg-blue-50 text-blue-700 ring-blue-600/20',
  hold: 'bg-amber-50 text-amber-800 ring-amber-600/25',
  block: 'bg-red-50 text-red-700 ring-red-600/20',
  approval: 'bg-violet-50 text-violet-700 ring-violet-600/20',
};

const STATUS = {
  paid: { label: 'Paid', cls: DECISION_CHIP.allow, dot: 'bg-emerald-500', tone: 'emerald' },
  escrow_authorised: { label: 'Escrow · authorised', cls: DECISION_CHIP.escrow, dot: 'bg-blue-500', tone: 'blue' },
  escrow_captured: { label: 'Escrow · captured', cls: DECISION_CHIP.escrow, dot: 'bg-blue-500', tone: 'blue' },
  escrow_cancelled: { label: 'Escrow · cancelled', cls: 'bg-slate-100 text-slate-600 ring-slate-500/20', dot: 'bg-slate-400', tone: 'slate' },
  held: { label: 'Held', cls: DECISION_CHIP.hold, dot: 'bg-amber-500', tone: 'amber' },
  rejected: { label: 'Rejected', cls: 'bg-slate-100 text-slate-600 ring-slate-500/20', dot: 'bg-slate-400', tone: 'slate' },
  blocked: { label: 'Blocked', cls: DECISION_CHIP.block, dot: 'bg-red-500', tone: 'red' },
};

function statusBadge(status, size = 'sm') {
  const s = STATUS[status] || { label: status || '—', cls: 'bg-slate-100 text-slate-600 ring-slate-500/20', dot: 'bg-slate-400' };
  const pad = size === 'lg' ? 'px-3 py-1 text-sm' : 'px-2 py-0.5 text-xs';
  return `<span class="inline-flex items-center gap-1.5 rounded-full ${pad} font-medium ring-1 ring-inset ${s.cls} whitespace-nowrap">
    <span class="h-1.5 w-1.5 rounded-full ${s.dot}"></span>${esc(s.label)}</span>`;
}

function ruleChip(id, decision) {
  const cls = DECISION_CHIP[decision] || 'bg-slate-100 text-slate-700 ring-slate-500/20';
  return `<span class="inline-flex items-center rounded-md px-1.5 py-0.5 font-mono text-[11px] font-semibold ring-1 ring-inset ${cls}">${esc(id)}</span>`;
}

function isExecuted(status) {
  return status === 'paid' || status === 'escrow_authorised' || status === 'escrow_captured';
}

function isOfflinePI(id) {
  return !id || String(id).startsWith('pi_offline');
}

// toast
function toast(msg, tone = 'slate') {
  let box = document.getElementById('toasts');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toasts';
    box.className = 'fixed bottom-5 left-1/2 -translate-x-1/2 z-[80] flex flex-col items-center gap-2';
    document.body.appendChild(box);
  }
  const tones = {
    slate: 'bg-slate-900 text-white',
    red: 'bg-red-600 text-white',
    green: 'bg-emerald-600 text-white',
    amber: 'bg-amber-500 text-white',
  };
  const t = document.createElement('div');
  t.className = `toast rounded-xl px-4 py-2.5 text-sm font-medium shadow-lg ${tones[tone] || tones.slate}`;
  t.textContent = msg;
  box.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transform = 'translateY(6px)'; }, 3800);
  setTimeout(() => t.remove(), 4300);
}

// ------------------------------------------------------- prove helpers --

function proveState(prove) {
  if (!prove || !Array.isArray(prove.theorems) || !prove.theorems.length) return 'pending';
  if (prove.running) return 'running';
  if (prove.theorems.some(t => t.status === 'pending')) return 'pending';
  return 'done';
}

function proveCounts(prove) {
  const ts = (prove && prove.theorems) || [];
  return {
    total: ts.length,
    proved: ts.filter(t => t.status === 'proved').length,
    failing: ts.filter(t => t.status === 'attack').length,
    other: ts.filter(t => t.status === 'timeout' || t.status === 'error').length,
  };
}

function theoremBadgeHTML(prove) {
  const st = proveState(prove);
  const c = proveCounts(prove);
  let cls, icon, text;
  if (st !== 'done') {
    cls = 'bg-slate-100 text-slate-600 ring-slate-300';
    icon = '<span class="spin inline-block h-3 w-3 rounded-full border-2 border-slate-400 border-t-transparent"></span>';
    text = 'proving…';
  } else if (c.failing > 0) {
    cls = 'bg-red-50 text-red-700 ring-red-300';
    icon = '<span class="font-bold">✗</span>';
    text = `${c.failing} failing`;
  } else if (c.other > 0) {
    cls = 'bg-amber-50 text-amber-800 ring-amber-300';
    icon = '<span>⏱</span>';
    text = `${c.proved}/${c.total} proved`;
  } else {
    cls = 'bg-emerald-50 text-emerald-700 ring-emerald-300';
    icon = '<span class="font-bold">✓</span>';
    text = `${c.proved}/${c.total} proved`;
  }
  return `<a href="${withMock('/settings')}" title="Theorems about this policy (Z3). Click for details."
     class="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ring-1 ring-inset ${cls} hover:brightness-95 transition">
     ${icon}<span>${text}</span></a>`;
}

function worstCaseHTML(prove, cap) {
  const wc = prove && prove.worst_case;
  const t1 = prove && (prove.theorems || []).find(t => t.id === 'T1');
  const n = prove && prove.n;
  let value, sub;
  if (wc && wc.status === 'optimal' && wc.value != null) {
    value = fmtGBP(wc.value);
    sub = `max unapproved spend / 30 days · Z3 optimum${n ? ` · ≤${n} payments` : ''}`;
  } else if (wc && wc.status === 'timeout' && t1 && t1.status === 'proved') {
    value = `≤ ${fmtGBP(cap || 500000)}`;
    sub = 'max unapproved spend / 30 days · proved by T1';
  } else if (wc && wc.status === 'timeout') {
    value = 'timeout';
    sub = 'optimiser hit its time limit';
  } else {
    value = '<span class="text-slate-400">computing…</span>';
    sub = 'max unapproved spend / 30 days';
  }
  const over = wc && wc.status === 'optimal' && wc.value > (cap || 500000);
  return `<div class="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Worst-case exposure</div>
    <div class="mt-1 text-3xl font-semibold tracking-tight ${over ? 'text-red-400' : 'text-white'}">${value}</div>
    <div class="mt-1 text-xs text-slate-400">${sub}</div>`;
}

function modeBadgesHTML(summary) {
  if (!summary) return '';
  const stripe = summary.stripe_mode === 'test'
    ? `<span class="inline-flex items-center gap-1.5 rounded-full bg-indigo-50 px-2.5 py-1 text-[11px] font-semibold text-indigo-700 ring-1 ring-inset ring-indigo-200"><span class="h-1.5 w-1.5 rounded-full bg-indigo-500"></span>Stripe test mode</span>`
    : `<span class="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-600 ring-1 ring-inset ring-slate-300"><span class="h-1.5 w-1.5 rounded-full bg-slate-400"></span>Stripe offline</span>`;
  const agent = summary.agent_mode === 'llm'
    ? `<span class="inline-flex items-center gap-1.5 rounded-full bg-violet-50 px-2.5 py-1 text-[11px] font-semibold text-violet-700 ring-1 ring-inset ring-violet-200"><span class="h-1.5 w-1.5 rounded-full bg-violet-500"></span>Agent: Claude</span>`
    : `<span class="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-600 ring-1 ring-inset ring-slate-300"><span class="h-1.5 w-1.5 rounded-full bg-slate-400"></span>Agent: fallback</span>`;
  const day = summary.day != null
    ? `<span class="inline-flex items-center rounded-full bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-700 ring-1 ring-inset ring-slate-200">Day ${esc(summary.day)}</span>` : '';
  return day + stripe + agent;
}

function policyChipHTML(policy) {
  if (!policy) return '';
  return `<a href="${withMock('/settings')}" class="inline-flex items-center gap-2 rounded-full bg-slate-900 px-3 py-1 text-xs font-semibold text-white hover:bg-slate-700 transition" title="${esc(policy.note || '')}">
    Policy ${esc(policy.version)}<span class="font-mono text-[11px] font-normal text-slate-400">#${esc(policy.hash)}</span></a>`;
}

function renderHeader(page) {
  const el = document.getElementById('hdr');
  if (!el) return;
  const tab = (href, label, key) => `<a href="${withMock(href)}"
      class="rounded-lg px-3 py-1.5 text-sm font-medium transition ${page === key ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'}">${label}</a>`;
  el.innerHTML = `
  <div class="mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-6 gap-y-3 px-6 py-3.5">
    <a href="${withMock('/')}" class="flex items-center gap-2.5">
      <span class="grid h-8 w-8 place-items-center rounded-lg bg-slate-900 text-white">
        <svg viewBox="0 0 24 24" class="h-4.5 w-4.5" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5l5 5L20 6.5"/></svg>
      </span>
      <span class="leading-none">
        <span class="block text-[19px] font-bold tracking-tight text-slate-900">Proven</span>
        <span class="block text-[11px] font-medium tracking-wide text-slate-400">proven, not prompted</span>
      </span>
    </a>
    <nav class="flex items-center gap-1">${tab('/', 'Payments', 'dash')}${tab('/settings', 'Policy & proofs', 'settings')}</nav>
    <div class="ml-auto flex flex-wrap items-center gap-2">
      <span id="hdr-modes" class="flex flex-wrap items-center gap-2"></span>
      <span class="mx-1 hidden h-5 w-px bg-slate-200 sm:block"></span>
      <span id="hdr-policy"></span>
      <span id="hdr-thm"></span>
    </div>
  </div>`;
}

function updateHeader({ policy, prove, summary }) {
  const p = document.getElementById('hdr-policy');
  const t = document.getElementById('hdr-thm');
  const m = document.getElementById('hdr-modes');
  if (p && policy) p.innerHTML = policyChipHTML(policy);
  if (t) t.innerHTML = theoremBadgeHTML(prove);
  if (m && summary) m.innerHTML = modeBadgesHTML(summary);
}

function p8Active(policy) {
  if (!policy || !Array.isArray(policy.rules)) return true;
  const r = policy.rules.find(r => r.id === 'P8');
  return !!(r && r.active);
}

// ------------------------------------------------------------ policy map --
// x: payment amount (£0–600), y: unapproved (auto) spend in the 30 days before it.

function drawPolicyMap(el, opts) {
  if (!el || !window.Plotly) return;
  const { payments = [], highlightId = null, attack = null, p8 = true, compact = false, cap = 500000 } = opts || {};
  const XMAX = 600;
  const capY = cap / 100;

  const ys = [];
  const byDecision = { allow: [], escrow: [], hold: [], block: [] };
  for (const p of payments) {
    if (p.amount == null) continue;
    const d = byDecision[p.decision] ? p.decision : 'hold';
    const xReal = p.amount / 100;
    const y = (p.auto_spend_before || 0) / 100;
    ys.push(y);
    byDecision[d].push({ p, x: Math.min(xReal, XMAX - 6), clipped: xReal > XMAX, y });
  }

  let attackPts = null;
  if (attack && Array.isArray(attack.payments)) {
    let cum = 0;
    attackPts = attack.payments.map((a, i) => {
      const pt = { x: a.amount / 100, y: cum / 100, a, i };
      if (a.auto) cum += a.amount;
      return pt;
    });
    // the end point: total auto spend after the last payment
    attackPts.forEach(pt => ys.push(pt.y));
    ys.push(cum / 100);
    attackPts.total = cum;
  }

  const yTop = Math.max(8000, ...ys.map(y => y * 1.08));

  const shapes = [
    { type: 'rect', xref: 'x', yref: 'y', x0: 0, x1: 100, y0: 0, y1: yTop, fillcolor: 'rgba(16,185,129,0.09)', line: { width: 0 }, layer: 'below' },
    { type: 'rect', xref: 'x', yref: 'y', x0: 100, x1: 500, y0: 0, y1: yTop, fillcolor: 'rgba(245,158,11,0.08)', line: { width: 0 }, layer: 'below' },
    { type: 'rect', xref: 'x', yref: 'y', x0: 500, x1: XMAX, y0: 0, y1: yTop, fillcolor: 'rgba(239,68,68,0.09)', line: { width: 0 }, layer: 'below' },
    { type: 'line', xref: 'x', yref: 'y', x0: 0, x1: XMAX, y0: capY, y1: capY,
      line: { color: p8 ? '#64748b' : '#dc2626', width: 2, dash: 'dash' } },
  ];
  // P8 holds everything above the cap: shade it lightly when P8 is active
  if (p8) shapes.push({ type: 'rect', xref: 'x', yref: 'y', x0: 0, x1: 500, y0: capY, y1: yTop, fillcolor: 'rgba(245,158,11,0.07)', line: { width: 0 }, layer: 'below' });

  const fs = compact ? 10 : 11;
  const annotations = [
    { x: 50, y: yTop, yanchor: 'top', text: 'ALLOW ≤ £100', showarrow: false, font: { size: fs, color: '#047857' } },
    { x: 300, y: yTop, yanchor: 'top', text: 'HOLD £100–£500 · P6', showarrow: false, font: { size: fs, color: '#b45309' } },
    { x: 550, y: yTop, yanchor: 'top', text: 'BLOCK · P5', showarrow: false, font: { size: fs, color: '#b91c1c' } },
    { x: XMAX, y: capY, xanchor: 'right', yanchor: 'bottom', showarrow: false,
      text: p8 ? 'P8 cap £5,000' : 'intended cap £5,000 (not enforced)',
      font: { size: fs, color: p8 ? '#475569' : '#dc2626' } },
  ];

  const traces = [];
  const decOrder = ['allow', 'escrow', 'hold', 'block'];
  for (const d of decOrder) {
    const pts = byDecision[d];
    traces.push({
      type: 'scatter', mode: 'markers', name: DECISION_LABEL[d],
      x: pts.map(q => q.x), y: pts.map(q => q.y),
      text: pts.map(q => `<b>${esc(q.p.invoice?.invoice_id || q.p.proposal?.invoice_id || q.p.id)}</b> · ${esc(q.p.vendor_name || '')}<br>${fmtGBP(q.p.amount)}${q.clipped ? ' (off chart)' : ''} · ${esc(STATUS[q.p.status]?.label || q.p.status)}<br>auto spend before: ${fmtGBP(q.p.auto_spend_before || 0)}`),
      customdata: pts.map(q => q.p.id),
      hovertemplate: '%{text}<extra></extra>',
      marker: {
        color: DECISION_COLOR[d], size: compact ? 9 : 11,
        symbol: pts.map(q => q.clipped ? 'triangle-right' : 'circle'),
        line: { color: '#fff', width: 1.5 }, opacity: highlightId ? 0.45 : 0.95,
      },
      showlegend: !compact,
    });
  }

  if (attackPts && attackPts.length) {
    traces.push({
      type: 'scatter', mode: 'lines+markers', name: 'Attack path',
      x: attackPts.map(p => p.x), y: attackPts.map(p => p.y),
      line: { color: '#dc2626', width: 2 },
      marker: { color: attackPts.map(p => p.a.auto ? '#dc2626' : '#fca5a5'), size: 6, line: { color: '#fff', width: 1 } },
      text: attackPts.map(p => `Attack #${p.i + 1} · day ${p.a.day} · ${esc(p.a.vendor)}${p.a.po ? ' · ' + esc(p.a.po) : ''}<br>${fmtGBP(p.a.amount)} ${p.a.auto ? '(auto)' : '(approved by a human)'}<br>auto spend before: ${fmtGBP(Math.round(p.y * 100))}`),
      hovertemplate: '%{text}<extra></extra>',
    });
    const last = attackPts[attackPts.length - 1];
    annotations.push({
      x: last.x, y: attackPts.total / 100, ax: 50, ay: -24, showarrow: true, arrowhead: 2, arrowcolor: '#dc2626',
      text: `<b>${fmtGBP(attackPts.total)} unapproved</b>`, font: { color: '#dc2626', size: 12 },
      bgcolor: 'rgba(255,255,255,0.9)', bordercolor: '#fecaca', borderpad: 3,
    });
  }

  if (highlightId) {
    const hp = payments.find(p => p.id === highlightId);
    if (hp && hp.amount != null) {
      const x = Math.min(hp.amount / 100, XMAX - 6);
      const y = (hp.auto_spend_before || 0) / 100;
      traces.push({
        type: 'scatter', mode: 'markers', name: 'This payment', showlegend: false,
        x: [x], y: [y], hoverinfo: 'skip',
        marker: { size: 22, color: 'rgba(0,0,0,0)', line: { color: '#0f172a', width: 2.5 } },
      });
      traces.push({
        type: 'scatter', mode: 'markers', showlegend: false, x: [x], y: [y], hoverinfo: 'skip',
        marker: { size: 12, color: DECISION_COLOR[hp.decision] || '#64748b', line: { color: '#fff', width: 2 } },
      });
      annotations.push({ x, y, ax: x > 450 ? -40 : 40, ay: -30, text: 'this payment', showarrow: true, arrowhead: 0,
        arrowcolor: '#0f172a', font: { size: 11, color: '#0f172a' }, bgcolor: 'rgba(255,255,255,0.85)' });
    }
  }

  const layout = {
    height: el.clientHeight || (compact ? 260 : 480),
    autosize: true,
    margin: compact ? { l: 52, r: 12, t: 8, b: 38 } : { l: 64, r: 16, t: 12, b: 48 },
    paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: '#ffffff',
    font: { family: 'Inter, ui-sans-serif, system-ui, sans-serif', color: '#334155', size: compact ? 10 : 12 },
    xaxis: { range: [0, XMAX], title: { text: 'Payment amount', standoff: 8 }, tickprefix: '£', tickvals: [0, 100, 200, 300, 400, 500, 600],
      gridcolor: '#eef2f7', zeroline: false, fixedrange: true },
    yaxis: { range: [0, yTop], title: { text: 'Unapproved spend in prior 30 days', standoff: 6 }, tickprefix: '£', tickformat: ',.0f',
      gridcolor: '#eef2f7', zeroline: false, fixedrange: true },
    shapes, annotations,
    showlegend: !compact,
    legend: { orientation: 'h', x: 0, y: -0.16, font: { size: 11 } },
    hoverlabel: { bgcolor: '#0f172a', bordercolor: '#0f172a', font: { color: '#fff', family: 'Inter, sans-serif', size: 12 } },
  };
  if (compact) { layout.xaxis.title = { text: 'amount', font: { size: 10 }, standoff: 4 }; layout.yaxis.title = { text: 'auto spend before', font: { size: 10 }, standoff: 4 }; }
  Plotly.react(el, traces, layout, { displayModeBar: false, responsive: true });
}

// ---------------------------------------------------------- dashboard --

const INJECTION_RE = /(system note( to (the )?ai agent)?|note to (the )?ai|ai agent|ignore (your|all|any|previous|the)[^.]*|disregard[^.]*|pre-?approved[^.]*|override|instructions? to)/ig;

function hasInjection(text) {
  if (!text) return false;
  INJECTION_RE.lastIndex = 0;
  return INJECTION_RE.test(text);
}

const Dash = {
  payments: [],
  summary: null,
  policy: null,
  prove: {},            // version -> result
  filter: 'all',
  selected: null,
  seen: null,           // Set of ids seen so far (null before first load)
  newAt: {},            // id -> ms when first seen
  lastFeedKey: '',
  lastPanelKey: '',
  busy: false,
  error: null,
};

const FILTERS = [
  { key: 'all', label: 'All', match: () => true },
  { key: 'paid', label: 'Paid', match: p => p.status === 'paid' },
  { key: 'escrow', label: 'Escrow', match: p => String(p.status).startsWith('escrow') },
  { key: 'held', label: 'Held', match: p => p.status === 'held' },
  { key: 'blocked', label: 'Blocked', match: p => p.status === 'blocked' },
];

async function dashRefresh() {
  if (Dash.busy) return;
  Dash.busy = true;
  try {
    const [payments, summary, policy] = await Promise.all([
      api('GET', '/api/payments'),
      api('GET', '/api/summary').catch(() => Dash.summary),
      api('GET', '/api/policy').catch(() => Dash.policy),
    ]);
    Dash.payments = payments || [];
    Dash.summary = summary;
    Dash.policy = policy;
    const versions = new Set();
    if (policy) versions.add(policy.version);
    const sel = Dash.selected && Dash.payments.find(p => p.id === Dash.selected);
    if (sel && sel.policy_version) versions.add(sel.policy_version);
    await Promise.all([...versions].map(v =>
      api('GET', `/api/prove?version=${encodeURIComponent(v)}`).then(r => { Dash.prove[v] = r; }).catch(() => {})));
    Dash.error = null;

    // new-row tracking
    const now = Date.now();
    if (Dash.seen === null) {
      Dash.seen = new Set(Dash.payments.map(p => p.id));
    } else {
      for (const p of Dash.payments) {
        if (!Dash.seen.has(p.id)) { Dash.seen.add(p.id); Dash.newAt[p.id] = now; }
      }
    }
    renderDash();
  } catch (e) {
    Dash.error = e.message || String(e);
    renderConn();
  } finally {
    Dash.busy = false;
  }
}

function renderConn() {
  const el = document.getElementById('conn');
  if (!el) return;
  if (Dash.error) {
    el.innerHTML = `<div class="mx-auto mt-4 max-w-[1400px] px-6"><div class="flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800">
      <span class="h-2 w-2 animate-pulse rounded-full bg-amber-500"></span>Waiting for the API… <span class="font-mono text-xs text-amber-700/80">${esc(Dash.error)}</span></div></div>`;
  } else el.innerHTML = '';
}

function renderDash() {
  renderConn();
  const activeProve = Dash.policy ? Dash.prove[Dash.policy.version] : null;
  updateHeader({ policy: Dash.policy, prove: activeProve, summary: Dash.summary });
  renderTiles(activeProve);
  renderChips();
  renderFeed();
  renderPanel();
}

function renderTiles(prove) {
  const s = Dash.summary || {};
  const cap = s.auto_cap || 500000;
  const used = s.auto_spend_window || 0;
  const pct = Math.min(100, (used / cap) * 100);
  const barColor = pct >= 100 ? 'bg-red-500' : pct >= 70 ? 'bg-amber-500' : 'bg-emerald-500';
  const set = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML = html; };
  const paidCount = Dash.payments.filter(p => p.status === 'paid' || p.status === 'escrow_captured').length;
  set('tile-paid', `<div class="tile-label">Total paid</div>
    <div class="tile-value">${fmtGBP(s.total_paid ?? 0)}</div>
    <div class="tile-sub">${paidCount} payment${paidCount === 1 ? '' : 's'} settled${s.escrow ? ` · ${s.escrow} in escrow` : ''}</div>`);
  set('tile-held', `<div class="tile-label">Held for approval</div>
    <div class="tile-value ${s.held ? 'text-amber-600' : ''}">${s.held ?? 0}</div>
    <div class="tile-sub">waiting for a human</div>`);
  set('tile-blocked', `<div class="tile-label">Blocked</div>
    <div class="tile-value ${s.blocked ? 'text-red-600' : ''}">${s.blocked ?? 0}</div>
    <div class="tile-sub">stopped by the gate</div>`);
  set('tile-meter', `<div class="flex items-baseline justify-between"><div class="tile-label">Unapproved spend · this 30-day window</div>
      <div class="text-xs font-medium text-slate-400">${pct.toFixed(pct < 10 && pct > 0 ? 1 : 0)}%</div></div>
    <div class="mt-1 flex items-baseline gap-2"><span class="tile-value">${fmtGBP(used)}</span><span class="text-sm font-medium text-slate-400">of ${fmtGBP(cap)} cap</span></div>
    <div class="mt-3 h-2.5 w-full overflow-hidden rounded-full bg-slate-100"><div class="h-full rounded-full ${barColor} transition-all duration-700" style="width:${pct}%"></div></div>
    <div class="tile-sub mt-2">Above the cap, P8 holds every payment for a human.</div>`);
  set('tile-worst', worstCaseHTML(prove, cap));
}

function renderChips() {
  const el = document.getElementById('chips');
  if (!el) return;
  el.innerHTML = FILTERS.map(f => {
    const n = Dash.payments.filter(f.match).length;
    const on = Dash.filter === f.key;
    return `<button data-filter="${f.key}" class="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold transition
      ${on ? 'bg-slate-900 text-white shadow-sm' : 'bg-white text-slate-600 ring-1 ring-inset ring-slate-200 hover:bg-slate-50'}">
      ${f.label}<span class="${on ? 'text-slate-300' : 'text-slate-400'} tabular-nums">${n}</span></button>`;
  }).join('');
}

function renderFeed() {
  const tbody = document.getElementById('feed');
  if (!tbody) return;
  const f = FILTERS.find(x => x.key === Dash.filter) || FILTERS[0];
  const rows = Dash.payments.filter(f.match);
  const key = JSON.stringify([Dash.filter, Dash.selected, rows.map(p => [p.id, p.status, p.stripe_status, p.captured_amount])]);
  if (key === Dash.lastFeedKey) return;
  Dash.lastFeedKey = key;

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="px-6 py-16 text-center">
      <div class="text-sm font-medium text-slate-500">${Dash.payments.length ? 'No payments match this filter.' : 'No payments yet.'}</div>
      <div class="mt-1 text-xs text-slate-400">${Dash.payments.length ? '' : 'Invoices posted to <span class="font-mono">/webhook/invoice</span> appear here live.'}</div></td></tr>`;
    return;
  }
  const now = Date.now();
  tbody.innerHTML = rows.map(p => {
    const inv = p.invoice?.invoice_id || p.proposal?.invoice_id || '—';
    const isNew = Dash.newAt[p.id] && now - Dash.newAt[p.id] < 2600;
    const delay = isNew ? `style="animation-delay:-${now - Dash.newAt[p.id]}ms"` : '';
    const sel = Dash.selected === p.id;
    const rules = (p.deciding_rules || []).map(r => ruleChip(r, p.decision)).join(' ');
    const approvedNote = p.decision === 'hold' && isExecuted(p.status) ? '<div class="mt-0.5 text-[11px] text-slate-400">after approval</div>' : '';
    const injected = hasInjection(p.invoice?.body);
    const stripe = p.stripe_pi_id
      ? (isOfflinePI(p.stripe_pi_id)
          ? `<span class="font-mono text-[11px] text-slate-400">${esc(p.stripe_pi_id)}</span>`
          : `<a href="${esc(p.stripe_url || `https://dashboard.stripe.com/test/payments/${p.stripe_pi_id}`)}" target="_blank" rel="noopener" onclick="event.stopPropagation()"
              class="inline-flex items-center gap-1 font-mono text-[11px] text-indigo-600 hover:text-indigo-800 hover:underline">${esc(String(p.stripe_pi_id).slice(0, 14))}…<span aria-hidden="true">↗</span></a>`)
      : p.stripe_error
        ? `<span title="${esc(p.stripe_error)}" class="inline-flex items-center gap-1 rounded-md bg-red-50 px-1.5 py-0.5 text-[11px] font-semibold text-red-700 ring-1 ring-inset ring-red-200">Stripe error</span>`
        : '<span class="text-slate-300">—</span>';
    return `<tr data-id="${esc(p.id)}" ${delay} class="feed-row cursor-pointer border-t border-slate-100 transition-colors ${sel ? 'bg-indigo-50/60' : 'hover:bg-slate-50'} ${isNew ? 'row-new' : ''}">
      <td class="whitespace-nowrap py-3 pl-6 pr-3 text-xs text-slate-500"><div class="font-medium tabular-nums text-slate-700">${fmtTime(p.created_at)}</div><div class="text-[11px] text-slate-400">day ${esc(p.day)}</div></td>
      <td class="whitespace-nowrap px-3 py-3"><div class="flex items-center gap-1.5 font-mono text-[13px] font-medium text-slate-900">${esc(inv)}${injected ? '<span title="Invoice text contains instructions to the agent" class="rounded bg-red-100 px-1 py-px font-sans text-[10px] font-bold uppercase tracking-wide text-red-700">injection</span>' : ''}</div></td>
      <td class="px-3 py-3 text-sm text-slate-700"><div class="max-w-[220px] truncate">${esc(p.vendor_name || p.proposal?.vendor_id || '')}</div></td>
      <td class="whitespace-nowrap px-3 py-3 text-right text-sm font-semibold tabular-nums text-slate-900">${fmtGBP(p.amount)}</td>
      <td class="whitespace-nowrap px-3 py-3">${statusBadge(p.status)}${approvedNote}</td>
      <td class="px-3 py-3"><div class="flex flex-wrap gap-1">${rules || '<span class="text-xs text-slate-400">all passed</span>'}</div></td>
      <td class="whitespace-nowrap py-3 pl-3 pr-6">${stripe}</td>
    </tr>`;
  }).join('');
}

// ----- side panel

function openPanel(id) {
  Dash.selected = id;
  Dash.lastPanelKey = '';
  Dash.lastFeedKey = '';
  const panel = document.getElementById('panel');
  panel.classList.remove('translate-x-full', 'shadow-none');
  panel.setAttribute('aria-hidden', 'false');
  document.getElementById('panel-scroll').scrollTop = 0;
  renderFeed();
  renderPanel();
  // make sure we have the prove result for this payment's version
  const p = Dash.payments.find(x => x.id === id);
  if (p && p.policy_version && !Dash.prove[p.policy_version]) {
    api('GET', `/api/prove?version=${encodeURIComponent(p.policy_version)}`)
      .then(r => { Dash.prove[p.policy_version] = r; Dash.lastPanelKey = ''; renderPanel(); }).catch(() => {});
  }
}

function closePanel() {
  Dash.selected = null;
  Dash.lastFeedKey = '';
  const panel = document.getElementById('panel');
  panel.classList.add('translate-x-full', 'shadow-none');
  panel.setAttribute('aria-hidden', 'true');
  renderFeed();
}

function section(title, body, extra = '') {
  return `<section class="border-t border-slate-100 px-6 py-5">
    <div class="mb-3 flex items-center justify-between gap-2"><h3 class="text-[11px] font-bold uppercase tracking-wider text-slate-400">${title}</h3>${extra}</div>
    ${body}</section>`;
}

function highlightInjection(text) {
  INJECTION_RE.lastIndex = 0;
  return esc(text).replace(INJECTION_RE, m => `<mark class="rounded bg-red-100 px-0.5 text-red-800">${m}</mark>`);
}

function renderPanel() {
  const body = document.getElementById('panel-body');
  if (!body || !Dash.selected) return;
  const p = Dash.payments.find(x => x.id === Dash.selected);
  if (!p) {
    body.innerHTML = '<div class="p-6 text-sm text-slate-500">Payment not found.</div>';
    return;
  }
  const prove = Dash.prove[p.policy_version] || null;
  const key = JSON.stringify([p, prove && prove.theorems && prove.theorems.map(t => t.status), Dash.policy && Dash.policy.version, p8Active(Dash.policy)]);
  if (key === Dash.lastPanelKey) return;
  Dash.lastPanelKey = key;

  // preserve UI state across re-render
  const prevApprover = document.getElementById('approver')?.value;
  const prevQty = document.getElementById('qty')?.value;
  const rawOpen = document.getElementById('raw-invoice')?.open;

  const st = STATUS[p.status] || {};
  const tone = st.tone || 'slate';
  const bannerCls = {
    emerald: 'bg-emerald-50 ring-emerald-200', blue: 'bg-blue-50 ring-blue-200', amber: 'bg-amber-50 ring-amber-200',
    red: 'bg-red-50 ring-red-200', slate: 'bg-slate-50 ring-slate-200',
  }[tone];
  const inv = p.invoice || {};
  const prop = p.proposal || {};
  const invId = inv.invoice_id || prop.invoice_id || p.id;

  // 1. verdict
  let html = `
  <div class="px-6 pb-5 pt-5">
    <div class="flex items-start justify-between gap-4">
      <div>
        <div class="flex items-center gap-2 font-mono text-sm font-semibold text-slate-900">${esc(invId)}
          <span class="font-sans text-xs font-normal text-slate-400">${esc(p.id)} · day ${esc(p.day)} · ${fmtTime(p.created_at)}</span></div>
        <div class="mt-0.5 text-sm text-slate-600">${esc(p.vendor_name || prop.vendor_id || '')}</div>
      </div>
      <div class="text-right">
        <div class="text-2xl font-semibold tracking-tight tabular-nums text-slate-900">${fmtGBP(p.amount)}</div>
        <div class="mt-1">${statusBadge(p.status, 'lg')}</div>
      </div>
    </div>
    <div class="mt-4 rounded-xl p-4 ring-1 ring-inset ${bannerCls}">
      <div class="text-[11px] font-bold uppercase tracking-wider text-slate-500">Verdict</div>
      <p class="mt-1 text-[15px] font-medium leading-snug text-slate-900">${esc(p.verdict || '')}</p>
      ${p.decision === 'hold' && isExecuted(p.status) ? '<p class="mt-1.5 text-xs text-slate-500">Approved by a human, then executed.</p>' : ''}
    </div>
  </div>`;

  // actions (held / escrow) — placed high so they're easy to reach during the demo
  if (p.status === 'held') {
    html += section('Actions', `
      <div class="flex flex-wrap items-center gap-2">
        <label class="text-sm text-slate-600" for="approver">Approver</label>
        <select id="approver" class="rounded-lg border-slate-300 bg-white py-1.5 pl-3 pr-8 text-sm font-medium text-slate-800 shadow-sm ring-1 ring-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500">
          <option value="alice">alice (CFO)</option><option value="bob">bob (Ops)</option></select>
        <button data-act="approve" class="rounded-lg bg-emerald-600 px-4 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700 transition">Approve</button>
        <button data-act="reject" class="rounded-lg bg-white px-4 py-1.5 text-sm font-semibold text-slate-700 shadow-sm ring-1 ring-inset ring-slate-300 hover:bg-slate-50 transition">Reject</button>
      </div>
      <p class="mt-2 text-xs text-slate-400">P12: whoever requested the PO can't approve the payment.${p.execute_as === 'escrow' ? ' On approval this runs as escrow.' : ''}</p>`);
  } else if (p.status === 'escrow_authorised') {
    const ordered = p.ordered_qty || 0;
    html += section('Actions', `
      <div class="flex flex-wrap items-center gap-2">
        <label class="text-sm text-slate-600" for="qty">Delivered</label>
        <input id="qty" type="number" min="0" ${ordered ? `max="${ordered}"` : ''} value="${ordered || 0}"
          class="w-24 rounded-lg border-0 py-1.5 px-3 text-sm font-medium tabular-nums text-slate-800 shadow-sm ring-1 ring-inset ring-slate-300 focus:ring-2 focus:ring-indigo-500" />
        <span class="text-sm text-slate-500">of ${ordered || '?'} ordered</span>
        <button data-act="deliver" class="rounded-lg bg-blue-600 px-4 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 transition">Simulate delivery</button>
      </div>
      <p id="capture-preview" class="mt-2 text-xs text-slate-500"></p>`);
  }

  // approvals history
  const approvals = p.approvals || [];
  if (approvals.length || p.status === 'held' || p.decision === 'hold') {
    html += section('Approvals', approvals.length ? `<ul class="space-y-2">${approvals.map(a => a.ok ? `
      <li class="flex items-start gap-2.5 rounded-lg bg-emerald-50 px-3 py-2 text-sm ring-1 ring-inset ring-emerald-200">
        <span class="mt-px font-bold text-emerald-600">✓</span>
        <div><span class="font-semibold text-emerald-900">${esc(a.approver)}</span> <span class="text-emerald-800">${esc(a.reason || 'approved')}</span>
        ${a.at ? `<div class="text-[11px] text-emerald-700/70">${fmtTime(a.at)}</div>` : ''}</div></li>` : `
      <li class="flex items-start gap-2.5 rounded-lg bg-red-50 px-3 py-2 text-sm ring-1 ring-inset ring-red-200">
        <span class="mt-px font-bold text-red-600">✗</span>
        <div><span class="font-semibold text-red-900">${esc(a.approver)}</span> <span class="text-red-800">approval refused</span>
        <div class="mt-0.5 text-red-700">${esc(a.reason || '')}</div>
        ${a.at ? `<div class="text-[11px] text-red-700/70">${fmtTime(a.at)}</div>` : ''}</div></li>`).join('')}</ul>`
      : '<p class="text-sm text-slate-400">No approvals yet.</p>');
  }

  // 2. rule trace
  const deciding = new Set(p.deciding_rules || []);
  const trace = p.trace || [];
  const firedCount = trace.filter(r => r.fired).length;
  html += section('Rule trace', `<ol class="space-y-1.5">${trace.map(r => {
    const col = DECISION_COLOR[r.decision] || '#64748b';
    const firedCls = r.fired
      ? { block: 'bg-red-50 ring-red-200', hold: 'bg-amber-50 ring-amber-200', escrow: 'bg-blue-50 ring-blue-200' }[r.decision] || 'bg-slate-50 ring-slate-200'
      : 'bg-white ring-slate-100';
    const icon = r.fired
      ? `<span class="grid h-5 w-5 shrink-0 place-items-center rounded-full text-[11px] font-bold text-white" style="background:${col}">✗</span>`
      : `<span class="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-emerald-100 text-[11px] font-bold text-emerald-700">✓</span>`;
    const ev = (r.evidence || []).filter(Boolean);
    return `<li class="rounded-lg px-3 py-2.5 ring-1 ring-inset ${firedCls}" ${r.fired ? `style="box-shadow: inset 3px 0 0 ${col}"` : ''}>
      <div class="flex items-start gap-2.5">${icon}
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span class="font-mono text-xs font-bold text-slate-900">${esc(r.rule_id)}</span>
            <span class="text-sm ${r.fired ? 'font-medium text-slate-900' : 'text-slate-600'}">${esc(r.text)}</span>
            ${r.fired ? `<span class="ml-auto rounded px-1.5 py-px text-[10px] font-bold uppercase tracking-wide text-white" style="background:${col}">${esc(r.decision)}${deciding.has(r.rule_id) ? ' · deciding' : ''}</span>` : ''}
          </div>
          ${r.detail ? `<div class="mt-1 font-mono text-[12px] ${r.fired ? 'text-slate-800' : 'text-slate-500'}">${esc(r.detail)}</div>` : ''}
          ${ev.length ? `<ul class="mt-1.5 space-y-0.5">${ev.map(e => `<li class="flex gap-1.5 text-[11.5px] text-slate-500"><span class="text-slate-300">↳</span><span>${esc(e)}</span></li>`).join('')}</ul>` : ''}
        </div></div></li>`;
  }).join('')}</ol>`, `<span class="text-xs text-slate-400">${trace.length} rules · ${firedCount} fired</span>`);

  // 3. agent proposal (untrusted)
  const injected = hasInjection(inv.body);
  const srcLabel = prop.source === 'compromised'
    ? '<span class="rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-semibold text-red-700 ring-1 ring-inset ring-red-200">source: simulated compromised agent</span>'
    : prop.source === 'llm'
    ? '<span class="rounded-full bg-violet-50 px-2 py-0.5 text-[11px] font-semibold text-violet-700 ring-1 ring-inset ring-violet-200">source: Claude (LLM)</span>'
    : '<span class="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600 ring-1 ring-inset ring-slate-200">source: structured fields (no LLM)</span>';
  const field = (k, v) => `<div><div class="text-[11px] text-slate-400">${k}</div><div class="font-mono text-[13px] font-medium text-slate-800">${v}</div></div>`;
  html += section('Agent proposal <span class="ml-1 rounded bg-slate-900 px-1.5 py-px text-[10px] tracking-wider text-white">UNTRUSTED</span>', `
    <div class="rounded-xl border border-dashed border-slate-300 bg-slate-50/60 p-4">
      <div class="grid grid-cols-4 gap-3">
        ${field('invoice', esc(prop.invoice_id || '—'))}${field('vendor', esc(prop.vendor_id || '—'))}
        ${field('amount', fmtGBP(prop.amount))}${field('PO', esc(prop.po_id || 'none'))}
      </div>
      ${prop.reasoning ? `<blockquote class="mt-3 border-l-2 border-slate-300 pl-3 text-sm italic leading-relaxed text-slate-600">“${esc(prop.reasoning)}”</blockquote>` : ''}
    </div>
    ${inv.amount != null && prop.amount != null && inv.amount !== prop.amount ? `<div class="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 ring-1 ring-inset ring-amber-200">
        The agent's amount differs from the invoice: invoice says <span class="font-semibold">${fmtGBP(inv.amount)}</span>, agent proposed <span class="font-semibold">${fmtGBP(prop.amount)}</span>. The gate checks the proposal.</div>` : ''}
    ${injected ? `<div class="mt-3 flex items-start gap-2.5 rounded-xl bg-red-600 px-4 py-3 text-sm text-white shadow-sm">
        <svg class="mt-0.5 h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4m0 4h.01M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"/></svg>
        <div><div class="font-semibold">This invoice contains instructions to the agent.</div>
        <div class="mt-0.5 text-red-100">The agent only proposes. The gate checks the proposal against the policy and never reads the invoice text${p.decision === 'block' ? `, so it was blocked by ${[...deciding].join(' and ')}.` : '.'}</div></div></div>` : ''}
    <details id="raw-invoice" class="group mt-3 rounded-xl ring-1 ring-inset ${injected ? 'ring-red-200' : 'ring-slate-200'}" ${(rawOpen ?? injected) ? 'open' : ''}>
      <summary class="flex cursor-pointer list-none items-center gap-2 px-4 py-2.5 text-sm font-medium text-slate-700">
        <span class="text-slate-400 transition group-open:rotate-90">▸</span>Raw invoice
        ${injected ? '<span class="rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-bold text-red-700 ring-1 ring-inset ring-red-200">⚠ contains instructions to the agent</span>' : ''}
      </summary>
      <div class="border-t ${injected ? 'border-red-100' : 'border-slate-100'} px-4 py-3">
        <div class="mb-2 grid grid-cols-4 gap-3 text-xs">
          ${field('invoice_id', esc(inv.invoice_id || '—'))}${field('vendor_id', esc(inv.vendor_id || '—'))}
          ${field('amount', inv.amount != null ? fmtGBP(inv.amount) : '—')}${field('po_id', esc(inv.po_id || '—'))}
        </div>
        <div class="text-[11px] text-slate-400">body</div>
        <pre class="mt-1 whitespace-pre-wrap break-words rounded-lg ${injected ? 'bg-red-50/60' : 'bg-slate-50'} p-3 font-mono text-[12px] leading-relaxed text-slate-800">${inv.body ? highlightInjection(inv.body) : '<span class="text-slate-400">(empty)</span>'}</pre>
      </div>
    </details>`);

  // 4. policy guarantees
  let g;
  if (prove && proveState(prove) === 'done') {
    const proved = prove.theorems.filter(t => t.status === 'proved').map(t => t.id);
    const failing = prove.theorems.filter(t => t.status === 'attack').map(t => t.id);
    const t1 = prove.theorems.find(t => t.id === 'T1');
    g = `<p class="text-sm text-slate-700">Checked against policy <span class="font-semibold">${esc(p.policy_version)}</span>
         <span class="font-mono text-xs text-slate-500">(hash ${esc(p.policy_hash)})</span>.</p>
      ${proved.length ? `<div class="mt-2 flex flex-wrap items-center gap-1.5"><span class="text-sm text-slate-700">Proved:</span>
        ${proved.map(id => `<span class="rounded-md bg-emerald-50 px-1.5 py-0.5 font-mono text-[11px] font-bold text-emerald-700 ring-1 ring-inset ring-emerald-200">✓ ${esc(id)}</span>`).join('')}
        <span class="text-xs text-slate-400">(up to ${esc(prove.n || 60)} payments / 30 days)</span></div>` : ''}
      ${failing.length ? `<div class="mt-2 flex flex-wrap items-center gap-1.5"><span class="text-sm text-red-700">Attack found:</span>
        ${failing.map(id => `<span class="rounded-md bg-red-50 px-1.5 py-0.5 font-mono text-[11px] font-bold text-red-700 ring-1 ring-inset ring-red-200">✗ ${esc(id)}</span>`).join('')}
        <a href="${withMock('/settings')}" class="text-xs font-medium text-red-700 underline">see attacks</a></div>` : ''}
      ${t1 && t1.status === 'proved' ? `<div class="mt-3 flex items-start gap-2.5 rounded-xl bg-slate-900 px-4 py-3 text-sm font-medium leading-snug text-white">
        <span class="mt-px text-emerald-400">✓</span><span>No sequence of payments this policy allows can move more than ${fmtGBP((Dash.summary && Dash.summary.auto_cap) || 500000)} in 30 days without a human.</span></div>` : ''}`;
  } else {
    g = `<p class="text-sm text-slate-700">Checked against policy <span class="font-semibold">${esc(p.policy_version)}</span>
      <span class="font-mono text-xs text-slate-500">(hash ${esc(p.policy_hash)})</span>.</p>
      <p class="mt-1.5 flex items-center gap-2 text-sm text-slate-400"><span class="spin inline-block h-3 w-3 rounded-full border-2 border-slate-300 border-t-transparent"></span>Prover running…</p>`;
  }
  html += section('Policy guarantees', g);

  // 5. stripe
  let s;
  if (p.stripe_pi_id) {
    const offline = isOfflinePI(p.stripe_pi_id);
    const url = p.stripe_url || `https://dashboard.stripe.com/test/payments/${p.stripe_pi_id}`;
    const released = p.status === 'escrow_captured' && p.captured_amount != null ? p.amount - p.captured_amount : null;
    s = `<dl class="grid grid-cols-[120px_1fr] gap-y-1.5 text-sm">
        <dt class="text-slate-400">PaymentIntent</dt><dd class="break-all font-mono text-[12.5px] text-slate-800">${esc(p.stripe_pi_id)}${offline ? ' <span class="ml-1 rounded bg-slate-100 px-1.5 py-px font-sans text-[10px] font-semibold text-slate-500">offline</span>' : ''}</dd>
        <dt class="text-slate-400">Status</dt><dd class="font-mono text-[12.5px] text-slate-800">${esc(p.stripe_status || '—')}</dd>
        <dt class="text-slate-400">Captured</dt><dd class="font-medium tabular-nums text-slate-800">${p.captured_amount != null ? fmtGBP(p.captured_amount) : (p.status === 'escrow_authorised' ? `<span class="text-blue-700">${fmtGBP(p.amount)} authorised, not captured</span>` : '—')}</dd>
        ${p.delivered_qty != null ? `<dt class="text-slate-400">Delivery</dt><dd class="text-slate-800">${esc(p.delivered_qty)} of ${esc(p.ordered_qty)} delivered${released != null ? ` · <span class="text-slate-500">${fmtGBP(released)} released</span>` : ''}</dd>` : ''}
      </dl>
      ${offline ? '' : `<a href="${esc(url)}" target="_blank" rel="noopener" class="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3.5 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 transition">Open in Stripe <span aria-hidden="true">↗</span></a>`}`;
  } else {
    s = `<p class="text-sm text-slate-400">${p.status === 'blocked' ? 'Blocked: no PaymentIntent was created. No money moved.' : p.status === 'held' ? 'Nothing sent to Stripe until a human approves.' : p.status === 'rejected' ? 'Rejected: no money moved.' : 'No PaymentIntent.'}</p>`;
  }
  if (p.stripe_error) s += `<div class="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-800 ring-1 ring-inset ring-red-200"><span class="font-semibold">Stripe call failed:</span> <span class="font-mono">${esc(p.stripe_error)}</span></div>`;
  html += section('Stripe', s);

  // 7. mini map
  html += section('Policy map', `<div id="mini-map" class="h-[240px] w-full"></div>
    <p class="mt-1 text-xs text-slate-400">Every payment at (amount, unapproved spend in the 30 days before it). Shading is the active policy.</p>`);

  body.innerHTML = html;

  // restore UI state
  if (prevApprover && document.getElementById('approver')) document.getElementById('approver').value = prevApprover;
  const qtyEl = document.getElementById('qty');
  if (qtyEl) {
    if (prevQty !== undefined && prevQty !== null && prevQty !== '') qtyEl.value = prevQty;
    const upd = () => {
      const q = parseInt(qtyEl.value || '0', 10) || 0;
      const ordered = p.ordered_qty || 0;
      const el = document.getElementById('capture-preview');
      if (!el || !ordered) return;
      const c = Math.floor(p.amount * Math.min(q, ordered) / ordered);
      el.innerHTML = q <= 0
        ? `Nothing delivered → cancel the PaymentIntent, release all ${fmtGBP(p.amount)}.`
        : `Capture <span class="font-semibold text-slate-800">${fmtGBP(c)}</span> (${fmtGBP(p.amount)} × ${q}/${ordered}); release ${fmtGBP(p.amount - c)}.`;
    };
    qtyEl.addEventListener('input', upd);
    upd();
  }
  drawPolicyMap(document.getElementById('mini-map'), {
    payments: Dash.payments, highlightId: p.id, p8: p8Active(Dash.policy), compact: true,
    cap: (Dash.summary && Dash.summary.auto_cap) || 500000,
  });
}

async function panelAction(act, btn) {
  const p = Dash.payments.find(x => x.id === Dash.selected);
  if (!p) return;
  btn.disabled = true;
  btn.classList.add('opacity-60');
  try {
    let res;
    if (act === 'approve' || act === 'reject') {
      const approver = document.getElementById('approver').value;
      res = await api('POST', `/api/payments/${encodeURIComponent(p.id)}/${act}`, { approver });
      if (act === 'approve') {
        const last = (res.approvals || [])[res.approvals.length - 1];
        if (last && last.ok === false) toast(`Approval refused — ${last.reason || 'P12'}`, 'red');
        else toast(`Approved by ${approver} → ${STATUS[res.status]?.label || res.status}`, 'green');
      } else toast(`Rejected by ${approver}`);
    } else if (act === 'deliver') {
      const q = parseInt(document.getElementById('qty').value || '0', 10) || 0;
      res = await api('POST', '/webhook/delivery', { payment_id: p.id, delivered_qty: q });
      toast(res.status === 'escrow_captured' ? `Delivered ${q} → captured ${fmtGBP(res.captured_amount)}` : 'Nothing delivered → escrow cancelled', 'green');
    }
    if (res && res.id) {
      const i = Dash.payments.findIndex(x => x.id === res.id);
      if (i >= 0) Dash.payments[i] = res;
      Dash.lastPanelKey = '';
      renderDash();
    }
    dashRefresh();
  } catch (e) {
    toast(e.message || String(e), 'red');
  } finally {
    btn.disabled = false;
    btn.classList.remove('opacity-60');
  }
}

function initDashboard() {
  renderHeader('dash');
  document.getElementById('chips').addEventListener('click', e => {
    const b = e.target.closest('[data-filter]');
    if (!b) return;
    Dash.filter = b.dataset.filter;
    renderChips();
    renderFeed();
  });
  document.getElementById('feed').addEventListener('click', e => {
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    if (Dash.selected === tr.dataset.id) closePanel(); else openPanel(tr.dataset.id);
  });
  document.getElementById('panel-close').addEventListener('click', closePanel);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closePanel(); });
  document.getElementById('panel-body').addEventListener('click', e => {
    const b = e.target.closest('[data-act]');
    if (b) panelAction(b.dataset.act, b);
  });
  dashRefresh();
  setInterval(dashRefresh, 2000);
}

if (document.body && document.body.dataset.page === 'dash') initDashboard();
