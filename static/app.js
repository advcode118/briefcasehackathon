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


// =============================================================== journal --
// Live dashboard (index.html). Ledger on the left, stats on the right.
// The expansion body is ONE function, renderExpansion(payment, proveResult),
// so its style can be swapped without touching the rest.

const J = {
  payments: [], summary: null, policy: null, prove: null,
  filter: 'all', open: new Set(), showPassed: new Set(), showRaw: new Set(),
  approver: {}, qty: {}, busy: new Set(),
  seen: null, fresh: new Set(), lastErr: null, lastProveAt: 0,
};

// Category comes from the PO (app/seed.py).
const PO_CATEGORY = { 'PO-1': 'Hosting', 'PO-2': 'Print', 'PO-3': 'Data labelling', 'PO-4': 'Print', 'PO-5': 'Supplies' };
const THEOREM_PLAIN = {
  T1: 'Unapproved spend can never exceed £5,000 in 30 days',
  T2: 'No vendor can receive over £100 in a day without approval',
  T3: 'An invoice can never be paid twice',
  T5: 'Never pays more than what was delivered on a purchase order',
  T6: 'Escrow never pays out more than was authorised',
  T7: 'Valid invoices are paid automatically',
};
const RULE_SHORT = {
  P4: 'Duplicate invoice', P5: 'Over the £500 single-payment limit', P6: 'Over £100 without approval',
  P7: 'Over £100 to one vendor in a day', P8: 'Over the £5,000 30-day cap', P9: 'No matching purchase order',
  P10: 'More than was delivered', P10_naive: 'More than was delivered',
};
const JC = { paid: '#2f6f4f', held: '#b8862b', blocked: '#a3302a', rejected: '#8b8373', track: '#ece8dc' };

const PAID_SET = new Set(['paid', 'escrow_authorised', 'escrow_captured']);
const REVIEW_SET = new Set(['held', 'blocked', 'rejected']);

function jVisible() {
  return J.payments.filter(p => J.filter === 'all' || (J.filter === 'paid' ? PAID_SET.has(p.status) : REVIEW_SET.has(p.status)));
}

function vendorShort(p) {
  return String(p.vendor_name || p.invoice?.vendor_id || '?').replace(/\s*\(.*\)\s*$/, '');
}

function relTime(iso) {
  const d = new Date(iso);
  if (!iso || isNaN(d)) return '';
  const s = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 86400) return Math.round(s / 3600) + ' h ago';
  return Math.round(s / 86400) + ' d ago';
}

// One line from the invoice body: first meaningful line, minus boilerplate.
function describe(p) {
  const body = String(p.invoice?.body || '');
  const lines = body.split(/\n+/).map(s => s.trim()).filter(Boolean)
    .filter(s => !/^(invoice|from|to|date|po|purchase order|amount|total|due)\b[^a-z]*[:#]/i.test(s));
  let s = lines.find(l => l.length > 12) || lines[0] || '';
  s = s.replace(/\s+/g, ' ');
  if (s.length > 90) s = s.slice(0, 88) + '…';
  const inv = p.invoice?.invoice_id || '';
  return s ? `${inv} · ${s}` : inv;
}

// ------------------------------------------------ plain-English reasons --
// Driven by the real trace entries (rule_id, detail) from app/rules.py.
const MONEY = '£[\\d,]+(?:\\.\\d\\d)?';

function traceTotal(t) {
  const m = new RegExp(`= (${MONEY}) [>≤] (${MONEY})`).exec(t.detail || '');
  return m ? { total: m[1], limit: m[2] } : null;
}

function plainReason(t, p) {
  const d = t.detail || '';
  const amt = fmtGBP(p.proposal?.amount ?? p.amount);
  const vendor = vendorShort(p);
  switch (t.rule_id) {
    case 'P4': return 'Invoice ' + d.replace(/^\S+\s+/, (p.invoice?.invoice_id || '') + ' ') + '.';
    case 'P5': return `${amt} is over the £500 single-payment limit.`;
    case 'P6': return `${amt} is over the £100 limit for payments without approval.`;
    case 'P7': { const x = traceTotal(t); return x ? `${vendor} would receive ${x.total} today — over the ${x.limit} daily limit without approval.` : d; }
    case 'P8': { const x = traceTotal(t); return x ? `Unapproved spend would reach ${x.total} in 30 days — over the ${x.limit} cap.` : d; }
    case 'P9': {
      if (/no purchase order/.test(d)) return 'No purchase order for this payment.';
      return d.charAt(0).toUpperCase() + d.slice(1) + '.';
    }
    case 'P10': {
      const m = new RegExp(`against (\\S+) (${MONEY}) \\+ (${MONEY}) = (${MONEY}) > (${MONEY}) \\(received (\\d+) × (${MONEY})\\)`).exec(d);
      if (!m) return d;
      const [, po, before, , total, limit, recv] = m;
      return before === '£0'
        ? `Only ${recv} received on ${po}: ${limit} is payable, ${total} was invoiced.`
        : `${po} would reach ${total} paid, but only ${limit} was delivered (${recv} received).`;
    }
    case 'P10_naive': {
      const m = new RegExp(`(${MONEY}) > (${MONEY}) \\(received (\\d+)`).exec(d);
      return m ? `${m[1]} is more than the ${m[2]} delivered (${m[3]} received).` : d;
    }
    case 'P11': return `${vendor} is an AI agent, so payments over £50 go through escrow.`;
    default: return (t.text ? t.text + ': ' : '') + d;
  }
}

const SEV = { allow: 0, escrow: 1, hold: 2, block: 3 };
function firedChecks(p) {
  return (p.trace || []).filter(t => t.fired && t.decision !== 'allow')
    .sort((a, b) => (SEV[b.decision] || 0) - (SEV[a.decision] || 0));
}

// "bob requested this purchase order, so bob cannot approve it."
function approvalSentence(a) {
  const m = /^P12: (\S+) requested ([^\s,]+)/.exec(a.reason || '');
  if (m) return `${m[1]} requested this purchase order (${m[2]}), so ${m[1]} cannot approve it.`;
  return `${a.approver} could not approve: ${a.reason || 'refused'}.`;
}

function escrowNote(p) {
  if (p.status === 'escrow_authorised') return 'held in escrow';
  if (p.status === 'escrow_captured') {
    const cap = p.captured_amount ?? p.amount;
    const rel = (p.amount || 0) - cap;
    return `${fmtGBP(cap)} captured on delivery of ${p.delivered_qty ?? '?'}/${p.ordered_qty ?? '?'}` + (rel > 0 ? `, ${fmtGBP(rel)} released` : '');
  }
  if (p.status === 'escrow_cancelled') return `escrow cancelled — nothing delivered, ${fmtGBP(p.amount)} released`;
  return '';
}

function okApprover(p) {
  const a = (p.approvals || []).filter(x => x.ok).slice(-1)[0];
  return a ? a.approver : null;
}

function oneLiner(p) {
  if (p.status.startsWith('escrow')) return `<span class="italic ink2">${esc(escrowNote(p))}</span>`;
  if (p.status === 'paid') {
    const who = okApprover(p);
    return who ? `<span class="italic ink3">approved by ${esc(who)}</span>` : '';
  }
  if (p.status === 'rejected') {
    const who = okApprover(p) || (p.approvals || []).slice(-1)[0]?.approver;
    return `<span class="italic ink3">rejected${who ? ' by ' + esc(who) : ''}</span>`;
  }
  const f = firedChecks(p)[0];
  if (!f) return '';
  return `<span class="${p.status === 'blocked' ? 'red' : 'amber'}">${esc(plainReason(f, p))}</span>`;
}

function statusWord(p) {
  return {
    paid: '<span class="green">paid</span>', escrow_authorised: '<span class="green">paid · escrow</span>',
    escrow_captured: '<span class="green">paid · escrow</span>', escrow_cancelled: '<span class="ink3">escrow cancelled</span>',
    held: '<span class="amber">awaiting approval</span>', blocked: '<span class="red">refused by policy</span>',
    rejected: '<span class="ink3">rejected</span>',
  }[p.status] || esc(p.status);
}

// ---------------------------------------------------- expansion (style) --
// Checklist style. Swap this one function to change the expansion style.

function checkLine(t, p) {
  const tot = traceTotal(t);
  const amt = fmtGBP(p.proposal?.amount ?? p.amount);
  const vendor = vendorShort(p);
  const d = t.detail || '';
  let label, nums = '';
  switch (t.rule_id) {
    case 'P4': label = 'Invoice not already paid'; nums = t.fired ? d : ''; break;
    case 'P5': label = 'Single-payment limit'; nums = `${amt} of £500`; break;
    case 'P6': label = 'Payments without approval'; nums = `${amt} of £100`; break;
    case 'P7': label = `Daily limit for ${vendor}`; nums = tot ? `${tot.total} of ${tot.limit}` : ''; break;
    case 'P8': label = '30-day unapproved spend'; nums = tot ? `${tot.total} of ${tot.limit}` : ''; break;
    case 'P9': label = 'Purchase order matches vendor'; nums = d; break;
    case 'P10': case 'P10_naive': {
      const m = new RegExp(`(?:= |alone: )(${MONEY}) [>≤] (${MONEY})`).exec(d);
      label = `Within what was delivered${p.invoice?.po_id ? ' on ' + p.invoice.po_id : ''}`;
      nums = m ? `${m[1]} of ${m[2]}` : d; break;
    }
    case 'P11': label = 'AI-agent vendors over £50 use escrow'; nums = t.fired ? `${amt}` : d; break;
    case 'P12': label = 'Requester cannot approve their own order'; nums = 'checked at approval'; break;
    default: label = t.text || t.rule_id; nums = d;
  }
  const verdict = !t.fired ? 'passed' : { block: 'refused', hold: 'needs approval', escrow: 'paid via escrow' }[t.decision] || 'failed';
  const col = !t.fired ? 'green' : t.decision === 'block' ? 'red' : t.decision === 'escrow' ? 'blue' : 'amber';
  const tint = !t.fired ? '' : t.decision === 'block' ? 'bg-[#a3302a]/[0.06]' : t.decision === 'escrow' ? 'bg-[#2f5f8f]/[0.06]' : 'bg-[#b8862b]/[0.08]';
  return `<div class="grid grid-cols-[18px_1fr_auto] items-baseline gap-x-2 px-2 py-1.5 ${tint}">
    <span class="${col} text-center text-[15px]">${t.fired ? (t.decision === 'escrow' ? '◐' : '✗') : '✓'}</span>
    <div><div class="text-[15px] ${t.fired ? 'font-semibold' : ''}">${esc(label)}</div>
      <div class="text-[13px] italic ink2">${esc(t.text || '')}${nums ? ` <span class="sans not-italic text-[12px]">· ${esc(nums)}</span>` : ''}</div></div>
    <span class="sans text-[11px] font-semibold uppercase tracking-wider ${col}">${verdict}</span></div>`;
}

function renderExpansion(p, prove) {
  const trace = p.trace || [];
  const failed = trace.filter(t => t.fired && t.decision !== 'allow').sort((a, b) => (SEV[b.decision] || 0) - (SEV[a.decision] || 0));
  const passed = trace.filter(t => !(t.fired && t.decision !== 'allow'));

  let html = `<div class="text-[12px] uppercase tracking-[0.15em] ink3 sans">Policy checks · ${failed.length ? `${failed.length} of ${trace.length} failed` : `all ${trace.length} passed`}</div>
    <div class="mt-1 divide-y divide-[#e3ddcd] border-y hair">${failed.concat(passed).map(t => checkLine(t, p)).join('')}</div>`;

  // status + actions
  const refusals = (p.approvals || []).filter(a => !a.ok)
    .map(a => `<div class="text-[14px] red">✗ ${esc(approvalSentence(a))}</div>`).join('');
  html += `<div class="mt-4 border-t hair pt-3">`;
  if (p.status === 'held') {
    const sel = J.approver[p.id] || 'alice';
    const busy = J.busy.has(p.id) ? 'disabled' : '';
    html += `<div><span class="font-semibold italic">Status:</span> <span class="amber">awaiting approval.</span> <span class="ink2">A human may approve or reject this payment.</span></div>
      ${refusals ? `<div class="mt-1">${refusals}</div>` : ''}
      <div class="sans mt-2 flex items-center gap-2">
        <select data-approver="${esc(p.id)}" class="field">
          <option value="alice" ${sel === 'alice' ? 'selected' : ''}>alice (CFO)</option>
          <option value="bob" ${sel === 'bob' ? 'selected' : ''}>bob (Ops)</option></select>
        <button data-act="approve" data-id="${esc(p.id)}" class="btn-approve" ${busy}>Approve</button>
        <button data-act="reject" data-id="${esc(p.id)}" class="btn-reject" ${busy}>Reject</button></div>`;
  } else if (p.status === 'blocked') {
    html += `<div><span class="font-semibold italic">Status:</span> <span class="red">refused by policy — cannot be approved.</span> <span class="ink2">No human can override a block; the vendor must send a corrected invoice.</span></div>`;
  } else if (p.status === 'escrow_authorised') {
    const q = J.qty[p.id] ?? (p.ordered_qty ?? '');
    const busy = J.busy.has(p.id) ? 'disabled' : '';
    html += `<div><span class="font-semibold italic">Status:</span> <span class="green">held in escrow.</span> <span class="ink2">Funds are authorised; they are captured in proportion to what is delivered.</span></div>
      <div class="sans mt-2 flex items-center gap-2 text-[12px]">
        <span class="ink2">Delivered</span>
        <input data-qty="${esc(p.id)}" type="number" min="0" ${p.ordered_qty ? `max="${p.ordered_qty}"` : ''} value="${esc(q)}" class="field w-20" />
        <span class="ink2">of ${esc(p.ordered_qty ?? '?')}</span>
        <button data-act="deliver" data-id="${esc(p.id)}" class="btn-approve" ${busy}>Record delivery</button></div>`;
  } else if (p.status === 'rejected') {
    html += `<div><span class="font-semibold italic">Status:</span> rejected${okApprover(p) ? ' by ' + esc(okApprover(p)) : ''}. No money moved.</div>${refusals ? `<div class="mt-1">${refusals}</div>` : ''}`;
  } else if (p.status.startsWith('escrow')) {
    html += `<div><span class="font-semibold italic">Status:</span> <span class="green">${esc(escrowNote(p))}.</span></div>`;
  } else {
    const who = okApprover(p);
    html += `<div><span class="font-semibold italic">Status:</span> <span class="green">paid</span>${who ? ` after approval by ${esc(who)}` : ' automatically: every check passed'}.${p.stripe_url ? ` <a class="quiet sans text-[12px]" href="${esc(p.stripe_url)}" target="_blank" rel="noopener">view in Stripe ↗</a>` : ''}</div>${refusals ? `<div class="mt-1">${refusals}</div>` : ''}`;
  }
  html += `</div>`;

  return html;
}

// -------------------------------------------------------------- ledger --

function renderFilters() {
  const n = {
    all: J.payments.length,
    paid: J.payments.filter(p => PAID_SET.has(p.status)).length,
    review: J.payments.filter(p => REVIEW_SET.has(p.status)).length,
  };
  document.getElementById('filters').innerHTML = `<div class="sans flex border border-[#1a1a1a] text-[12px]">${[['all', 'All'], ['paid', 'Paid'], ['review', 'Needs review']].map(([k, l]) =>
    `<button data-filter="${k}" class="px-2.5 py-0.5 ${J.filter === k ? 'bg-[#1a1a1a] text-[#fdfcf8]' : ''}">${l} <span class="opacity-60">${n[k]}</span></button>`).join('')}</div>`;
}

function rowHTML(p) {
  const open = J.open.has(p.id);
  return `<div data-row="${esc(p.id)}" class="border-b hair last:border-b-0 ${J.fresh.has(p.id) ? 'row-new' : ''}">
    <div data-toggle="${esc(p.id)}" class="row-btn grid grid-cols-[18px_36px_1fr_auto] items-start gap-3 px-1 py-3">
      <span class="sans chev ${open ? 'open' : ''} pt-1 text-[14px] ink3">▸</span>
      <span class="grid h-8 w-8 place-items-center rounded-full bg-[#ece8dc] text-[14px] font-semibold">${esc(vendorShort(p)[0] || '?')}</span>
      <div class="min-w-0"><div class="text-[15px] font-semibold">${esc(vendorShort(p))}</div>
        <div class="truncate text-[14px] italic ink2">${esc(describe(p))}</div>
        <div class="mt-0.5 text-[14px]">${oneLiner(p)}</div></div>
      <div class="text-right"><div class="text-[17px] font-semibold tnum">${esc(fmtGBP(p.amount))}</div>
        <div class="text-[13px] italic">${statusWord(p)}</div><div class="text-[12px] italic ink3" data-ago="${esc(p.created_at)}">${esc(relTime(p.created_at))}</div></div>
    </div>
    ${open ? `<div data-exp="${esc(p.id)}" class="fade-in mx-2 mb-5 mt-1 bg-white/60 px-5 py-4 ring-1 ring-[#e3ddcd]">${renderExpansion(p, J.prove)}</div>` : ''}
  </div>`;
}

// Key that captures everything a row renders, so unchanged rows are left alone.
function rowKey(p) {
  return JSON.stringify([p.status, p.approvals?.length, p.captured_amount, p.stripe_status, p.delivered_qty,
    J.open.has(p.id), J.showPassed.has(p.id), J.showRaw.has(p.id), J.busy.has(p.id), J.fresh.has(p.id),
    J.open.has(p.id) ? (J.prove?.theorems || []).map(t => t.status).join() : '']);
}

function renderLedger(force) {
  const box = document.getElementById('ledger');
  const rows = jVisible();
  if (!rows.length) {
    box.innerHTML = `<div class="py-10 text-center italic ink3">${J.payments.length ? 'Nothing in this view.' : 'No payments yet. Send an invoice to /webhook/invoice.'}</div>`;
    return;
  }
  // Rebuild only rows whose content changed; keep focused inputs intact.
  const existing = new Map([...box.querySelectorAll(':scope > [data-row]')].map(el => [el.dataset.row, el]));
  if (existing.size === 0) box.innerHTML = '';
  const frag = [];
  for (const p of rows) {
    const key = rowKey(p);
    let el = existing.get(p.id);
    if (!el || el.dataset.key !== key || force) {
      const active = document.activeElement;
      if (el && active && el.contains(active) && !force) { frag.push(el); continue; } // user is typing here
      const tmp = document.createElement('div');
      tmp.innerHTML = rowHTML(p);
      const nu = tmp.firstElementChild;
      nu.dataset.key = key;
      if (el) el.replaceWith(nu); // swap in place; unchanged rows stay attached
      el = nu;
    }
    frag.push(el);
  }
  // Re-attaching every row closes open dropdowns and replays animations, so only
  // rebuild the list when the set or order of rows changed.
  const current = [...box.children];
  if (current.length !== frag.length || frag.some((el, i) => current[i] !== el)) box.replaceChildren(...frag);
  box.querySelectorAll('[data-ago]').forEach(e => { e.textContent = relTime(e.dataset.ago); });
}

// ------------------------------------------------------------ side column --

function sideStats() {
  const c = { paid: 0, held: 0, blocked: 0, rejected: 0 };
  for (const p of J.payments) {
    if (PAID_SET.has(p.status)) c.paid++;
    else if (p.status in c) c[p.status]++;
  }
  return c;
}

function donutSVG(c, n, size = 150, sw = 20) {
  const r = (size - sw) / 2, C = 2 * Math.PI * r; let off = 0;
  const segs = n ? ['paid', 'held', 'blocked', 'rejected'].filter(k => c[k]).map(k => {
    const len = c[k] / n * C;
    const s = `<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${JC[k]}" stroke-width="${sw}" stroke-dasharray="${Math.max(len - 2, 1)} ${C - len + 2}" stroke-dashoffset="${-off}"/>`;
    off += len; return s;
  }).join('') : '';
  return `<svg width="${size}" height="${size}" class="shrink-0"><circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${JC.track}" stroke-width="${sw}"/>
    <g transform="rotate(-90 ${size / 2} ${size / 2})">${segs}</g>
    <text x="50%" y="48%" text-anchor="middle" class="serif" font-size="28" font-weight="600" fill="#1a1a1a">${n}</text>
    <text x="50%" y="63%" text-anchor="middle" class="serif" font-size="12" font-style="italic" fill="#6b6457">payments</text></svg>`;
}

function effectivePaid(p) {
  if (p.status === 'escrow_captured') return p.captured_amount ?? 0;
  if (PAID_SET.has(p.status)) return p.amount || 0;
  return 0;
}

function renderSide() {
  const s = J.summary || {};
  const c = sideStats();
  const n = J.payments.length;
  const totalPaid = s.total_paid ?? J.payments.reduce((a, p) => a + effectivePaid(p), 0);
  const cap = s.auto_cap ?? 500000, spent = s.auto_spend_window ?? 0;
  const pct = cap ? Math.min(100, spent / cap * 100) : 0;
  const legend = [['paid', 'Paid'], ['held', 'Awaiting approval'], ['blocked', 'Refused by policy'], ['rejected', 'Rejected']]
    .map(([k, l]) => `<div class="flex items-center gap-2"><span class="h-2.5 w-2.5" style="background:${JC[k]}"></span><span class="w-36">${l}</span><span class="tnum font-semibold">${c[k]}</span></div>`).join('');

  // spending by category (paid, plus pending = awaiting approval)
  const cats = {};
  for (const p of J.payments) {
    const cat = PO_CATEGORY[p.invoice?.po_id] || 'No purchase order';
    cats[cat] = cats[cat] || { paid: 0, pending: 0 };
    cats[cat].paid += effectivePaid(p);
    if (p.status === 'held') cats[cat].pending += p.amount || 0;
  }
  const catRows = Object.entries(cats).filter(([, v]) => v.paid || v.pending).sort((a, b) => (b[1].paid + b[1].pending) - (a[1].paid + a[1].pending));
  const maxCat = Math.max(1, ...catRows.map(([, v]) => v.paid + v.pending));
  const spend = catRows.length ? catRows.map(([k, v]) => `<div class="py-1.5">
      <div class="flex items-baseline justify-between text-[14px]"><span>${esc(k)}</span>
        <span class="sans text-[13px] tnum">${esc(fmtGBP(v.paid))}${v.pending ? ` <span class="ink3 text-[11px]">+${esc(fmtGBP(v.pending))} pending</span>` : ''}</span></div>
      <div class="mt-1 h-1 bg-[#ece8dc]"><div class="flex h-full"><div style="width:${v.paid / maxCat * 100}%;background:${JC.paid}"></div><div style="width:${v.pending / maxCat * 100}%;background:${JC.held};opacity:.45"></div></div></div>
    </div>`).join('') : '<div class="py-2 italic ink3 text-[14px]">Nothing yet.</div>';

  // block reasons (plain English), from fired trace entries of stopped payments
  const reasons = { block: {}, hold: {} };
  for (const p of J.payments) {
    if (!REVIEW_SET.has(p.status) && p.decision !== 'hold' && p.decision !== 'block') continue;
    for (const t of p.trace || []) {
      if (!t.fired || !(t.decision in reasons)) continue;
      const l = RULE_SHORT[t.rule_id] || t.text || t.rule_id;
      reasons[t.decision][l] = (reasons[t.decision][l] || 0) + 1;
    }
  }
  const rgrp = (title, obj, col) => {
    const rows = Object.entries(obj).sort((a, b) => b[1] - a[1]);
    if (!rows.length) return '';
    return `<div class="mt-2 text-[13px] italic ink2">${title}</div>` + rows.map(([l, k]) =>
      `<div class="flex items-center gap-2 border-b hair py-1.5 text-[14px] last:border-b-0"><span class="${col}">●</span><span class="flex-1">${esc(l)}</span><span class="sans tnum font-semibold">${k}</span></div>`).join('');
  };
  const reasonHTML = (rgrp('Refused by policy', reasons.block, 'red') + rgrp('Held for a human', reasons.hold, 'amber')) || '<div class="py-2 italic ink3 text-[14px]">Nothing stopped yet.</div>';

  document.getElementById('side').innerHTML = `
    <section>
      <div class="mb-3 flex items-baseline justify-between"><h2 class="text-[21px] font-semibold"><span class="ink3 mr-2">2.</span>Stats · Last 30 days</h2>
        <div class="sans flex border border-[#1a1a1a] text-[11px]" title="visual only"><button class="bg-[#1a1a1a] px-2.5 py-0.5 text-[#fdfcf8]">30d</button><button class="px-2.5 py-0.5">6m</button><button class="px-2.5 py-0.5">1y</button></div></div>
      <div class="text-[12px] uppercase tracking-[0.15em] ink3 sans">Total paid</div>
      <div class="text-[56px] font-semibold leading-none tnum">${esc(fmtGBP(totalPaid))}</div>
      <div class="mt-4 flex items-center gap-6">${donutSVG(c, n)}<div class="space-y-1.5 text-[14px]">${legend}</div></div>
      <div class="mt-2 text-[13px] ink2"><b>Fig. 1.</b> Outcomes by count (n = ${n}).</div>
      <div class="mt-5"><div class="sans flex items-baseline justify-between text-[12px] ink2"><span>Unapproved spend vs cap (30 days)</span><span class="tnum">${esc(fmtGBP(spent))} / ${esc(fmtGBP(cap))}</span></div>
        <div class="mt-1 h-1.5 bg-[#ece8dc]"><div class="h-full bg-[#2f6f4f]" style="width:${Math.max(pct, 0.8)}%"></div></div></div>
    </section>
    <div class="grid grid-cols-1 gap-8 sm:grid-cols-2">
      <section><h2 class="mb-2 text-[18px] font-semibold"><span class="ink3 mr-2">3.</span>Spending breakdown</h2>${spend}
        <div class="mt-1.5 text-[12px] ink2"><b>Fig. 2.</b> By purchase-order category; amber = awaiting approval.</div></section>
      <section><h2 class="mb-2 text-[18px] font-semibold"><span class="ink3 mr-2">4.</span>Why payments stopped</h2>${reasonHTML}
        <div class="mt-1.5 text-[12px] ink2">A payment can fail more than one check.</div></section>
    </div>`;
}

function renderMasthead() {
  const s = J.summary || {};
  const stripe = s.stripe_mode === 'test' ? 'Stripe test mode' : s.stripe_mode === 'offline' ? 'Stripe offline' : 'Stripe …';
  const agent = s.agent_mode === 'llm' ? 'agent: Claude' : s.agent_mode === 'fallback' ? 'agent: fallback (no LLM)' : 'agent …';
  document.getElementById('masthead').innerHTML = `<div class="flex flex-wrap items-end justify-between gap-3">
      <div><div class="text-[34px] font-semibold tracking-tight">Proven</div><div class="text-[14px] italic ink2">proven, not prompted</div></div>
      <div class="flex flex-wrap items-center gap-2 text-[13px] italic ink2">
        <span>Accounts payable, Acme Ltd${s.day != null ? ' · day ' + esc(s.day) : ''}</span>
        <span class="badge sans ${s.stripe_mode === 'test' ? 'blue' : 'ink3'}">${esc(stripe)}</span>
        <span class="badge sans ${s.agent_mode === 'llm' ? 'green' : 'amber'}">${esc(agent)}</span>
        <a href="/settings" class="sans not-italic text-[12px] quiet">Settings →</a></div></div>
    <div class="mt-4 border-t-2 border-[#1a1a1a]"></div><div class="mt-[2px] border-t border-[#1a1a1a]"></div>`;
}

// ------------------------------------------------------------- refresh --

async function journalRefresh() {
  try {
    const [payments, summary] = await Promise.all([api('GET', '/api/payments'), api('GET', '/api/summary')]);
    if (J.seen === null) J.seen = new Set(payments.map(p => p.id));
    for (const p of payments) {
      if (!J.seen.has(p.id)) {
        J.seen.add(p.id); J.fresh.add(p.id);
        setTimeout(() => { J.fresh.delete(p.id); }, 2700);
      }
    }
    J.payments = payments; J.summary = summary; J.lastErr = null;
    if (!J.prove || Date.now() - J.lastProveAt > 10000) {
      J.lastProveAt = Date.now();
      try {
        J.policy = await api('GET', '/api/policy');
        J.prove = await api('GET', '/api/prove?version=' + encodeURIComponent(J.policy.version || 'v4'));
      } catch (_) { /* prove is optional */ }
    }
  } catch (e) {
    J.lastErr = e.message;
  }
  document.getElementById('conn').innerHTML = J.lastErr
    ? `<div class="mt-3 border border-[#a3302a]/40 bg-[#a3302a]/[0.05] px-3 py-1.5 text-[13px] red">Cannot reach the server (${esc(J.lastErr)}). Retrying…</div>` : '';
  renderMasthead(); renderFilters(); renderLedger(); renderSide();
}

async function journalAction(act, id) {
  const p = J.payments.find(x => x.id === id);
  if (!p) return;
  J.busy.add(id); renderLedger(true);
  try {
    let res;
    if (act === 'approve' || act === 'reject') {
      const approver = J.approver[id] || 'alice';
      res = await api('POST', `/api/payments/${encodeURIComponent(id)}/${act}`, { approver });
      const last = (res.approvals || []).slice(-1)[0];
      if (act === 'approve' && last && !last.ok) toast(approvalSentence(last), 'red');
      else toast(act === 'approve' ? `Approved by ${approver}` : `Rejected by ${approver}`, act === 'approve' ? 'green' : 'slate');
    } else if (act === 'deliver') {
      const q = parseInt(J.qty[id] ?? p.ordered_qty, 10);
      if (isNaN(q) || q < 0) { toast('Enter a delivered quantity', 'amber'); return; }
      res = await api('POST', '/webhook/delivery', { payment_id: id, delivered_qty: q });
      toast(q === 0 ? 'Nothing delivered: escrow cancelled' : `Delivery of ${q} recorded`, 'green');
      delete J.qty[id];
    }
    if (res) J.payments = J.payments.map(x => x.id === id ? res : x);
  } catch (e) {
    toast(e.message, 'red');
  } finally {
    J.busy.delete(id);
    renderFilters(); renderLedger(true); renderSide();
  }
}

function initJournal() {
  document.getElementById('filters').addEventListener('click', e => {
    const b = e.target.closest('[data-filter]');
    if (!b) return;
    J.filter = b.dataset.filter;
    renderFilters(); renderLedger(true);
  });
  const ledger = document.getElementById('ledger');
  ledger.addEventListener('click', e => {
    const a = e.target.closest('[data-act]');
    if (a) {
      const id = a.dataset.id;
      if (a.dataset.act === 'toggle-passed') { J.showPassed.has(id) ? J.showPassed.delete(id) : J.showPassed.add(id); renderLedger(true); }
      else if (a.dataset.act === 'toggle-raw') { J.showRaw.add(id); renderLedger(true); }
      else journalAction(a.dataset.act, id);
      return;
    }
    if (e.target.closest('select, input, a')) return;
    const t = e.target.closest('[data-toggle]');
    if (t) {
      const id = t.dataset.toggle;
      J.open.has(id) ? J.open.delete(id) : J.open.add(id);
      renderLedger(true);
    }
  });
  ledger.addEventListener('change', e => {
    if (e.target.dataset.approver) J.approver[e.target.dataset.approver] = e.target.value;
  });
  ledger.addEventListener('input', e => {
    if (e.target.dataset.qty) J.qty[e.target.dataset.qty] = e.target.value;
  });
  journalRefresh();
  setInterval(journalRefresh, 2000);
}

if (document.body && document.body.dataset.page === 'journal') initJournal();
