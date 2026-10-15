/* Proven — settings page ("Journal" style): version selector, rules, theorems, policy map.
 * Self-contained: does not load app.js, so the dashboard code can change freely.
 * Money from the API is integer pence. */

// ---------------------------------------------------------------- helpers --

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

function toast(msg, tone) {
  let box = document.getElementById('toasts');
  if (!box) { box = document.createElement('div'); box.id = 'toasts'; document.body.appendChild(box); }
  const t = document.createElement('div');
  t.className = 'toast' + (tone === 'red' ? ' red' : '');
  t.textContent = msg;
  box.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transform = 'translateY(6px)'; }, 3800);
  setTimeout(() => t.remove(), 4300);
}

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

function p8Active(policy) {
  if (!policy || !Array.isArray(policy.rules)) return true;
  const r = policy.rules.find(r => r.id === 'P8');
  return !!(r && r.active);
}

// Journal palette (muted ink)
const J = {
  ink: '#1a1a1a', ink2: '#4a4438', muted: '#6b6457', faint: '#8b8373', rule: '#d8d2c2', paper: '#fdfcf8', track: '#ece8dc',
  green: '#2f6f4f', blue: '#3c5a8a', amber: '#b8862b', amberInk: '#9a6f1f', red: '#a3302a',
};
const DECISION_COLOR = { allow: J.green, escrow: J.blue, hold: J.amber, block: J.red, approval: '#6b4f8a' };
const DECISION_LABEL = { allow: 'Allow', escrow: 'Escrow', hold: 'Hold for approval', block: 'Block', approval: 'Approval' };
const STATUS_LABEL = { paid: 'Paid', escrow_authorised: 'Escrow · authorised', escrow_captured: 'Escrow · captured', escrow_cancelled: 'Escrow · cancelled', held: 'Held', rejected: 'Rejected', blocked: 'Blocked' };

// Plain-English headlines for finance readers; ids stay as small refs.
const THM_PLAIN = {
  T1: 'Unapproved spend can never exceed £5,000 in 30 days',
  T2: 'No vendor can receive over £100 in a day without approval',
  T3: 'An invoice can never be paid twice',
  T5: 'Never pays more than what was delivered on a purchase order',
  T6: 'Escrow never pays out more than was authorised',
  T7: 'Valid invoices are paid automatically',
  T8: 'Allows nothing the final CFO policy would block',
};
const THM_STATUS = {
  proved: ['Proven ✓', 'proved'],
  attack: ['Loophole found ✗', 'attack'],
  timeout: ['Timed out', 'timeout'],
  error: ['Error', 'error'],
  pending: ['<span class="spin"></span> Proving…', 'pending'],
};

// ------------------------------------------------------------ header --

function renderHeader() {
  const el = document.getElementById('hdr');
  if (!el) return;
  el.innerHTML = `
    <div class="mast-row">
      <div><a href="${withMock('/')}" class="brand">Proven</a><span class="tagline">proven, not prompted</span></div>
      <nav class="tabs"><a href="${withMock('/')}">Payments</a><a href="${withMock('/settings')}" class="on">Policy &amp; proofs</a></nav>
    </div>
    <div id="hdr-meta" class="mast-meta" style="margin-top:4px"></div>
    <div class="double-rule"></div><div class="thin"></div>`;
}

function updateHeader({ policy, prove, summary }) {
  const m = document.getElementById('hdr-meta');
  if (!m) return;
  const bits = ['Accounts payable'];
  if (summary && summary.day != null) bits.push(`day ${esc(summary.day)}`);
  if (summary) bits.push(summary.stripe_mode === 'test' ? 'Stripe test mode' : 'Stripe offline');
  if (summary) bits.push(summary.agent_mode === 'llm' ? 'agent: Claude' : 'agent: fallback');
  if (policy) bits.push(`policy ${esc(policy.version)} <span class="ref">#${esc(policy.hash)}</span>`);
  const st = proveState(prove);
  const c = proveCounts(prove);
  if (st !== 'done') bits.push('proving…');
  else if (c.failing) bits.push(`<span style="color:${J.red}">${c.failing} loophole${c.failing > 1 ? 's' : ''} found</span>`);
  else bits.push(`<span style="color:${J.green}">${c.proved} of ${c.total} proven</span>`);
  m.innerHTML = bits.join(' · ');
}

// ------------------------------------------------------------ state --

const S = {
  policy: null,
  prove: null,
  payments: [],
  summary: null,
  attackId: null,
  proveTimer: null,
  error: null,
};

async function sLoadAll() {
  try {
    const policy = await api('GET', '/api/policy');
    S.policy = policy;
    const [prove, payments, summary] = await Promise.all([
      api('GET', `/api/prove?version=${encodeURIComponent(policy.version)}`).catch(() => null),
      api('GET', '/api/payments').catch(() => S.payments),
      api('GET', '/api/summary').catch(() => S.summary),
    ]);
    S.prove = prove;
    S.payments = payments || [];
    S.summary = summary;
    S.error = null;
    sRender();
    sMaybePollProve();
  } catch (e) {
    S.error = e.message || String(e);
    sRenderConn();
  }
}

async function sLight() {
  // keep dots, day and header fresh without touching the prover state
  try {
    const [payments, summary] = await Promise.all([api('GET', '/api/payments'), api('GET', '/api/summary')]);
    const changed = JSON.stringify(payments.map(p => [p.id, p.status])) !== JSON.stringify(S.payments.map(p => [p.id, p.status]));
    S.payments = payments; S.summary = summary; S.error = null;
    sRenderConn();
    updateHeader({ policy: S.policy, prove: S.prove, summary: S.summary });
    sRenderDay();
    if (changed) sRenderMap();
  } catch (e) {
    S.error = e.message || String(e);
    sRenderConn();
    if (!S.policy) sLoadAll();
  }
}

function sMaybePollProve() {
  const st = proveState(S.prove);
  const busy = (S.prove && S.prove.running) || st !== 'done';
  if (busy && !S.proveTimer) {
    S.proveTimer = setInterval(async () => {
      try {
        const v = S.policy.version;
        const r = await api('GET', `/api/prove?version=${encodeURIComponent(v)}`);
        if (!S.policy || S.policy.version !== v) return;
        S.prove = r;
        sRenderProve();
        const done = proveState(r) === 'done' && !r.running;
        if (done) { clearInterval(S.proveTimer); S.proveTimer = null; }
      } catch (_) { /* keep trying */ }
    }, 1500);
  }
}

// ------------------------------------------------------------ render --

function sRenderConn() {
  const el = document.getElementById('conn');
  if (!el) return;
  el.innerHTML = S.error
    ? `<div class="banner">Waiting for the API… <span class="ref">${esc(S.error)}</span></div>`
    : '';
}

function sRender() {
  sRenderConn();
  updateHeader({ policy: S.policy, prove: S.prove, summary: S.summary });
  sRenderDay();
  sRenderVersions();
  sRenderRules();
  sRenderProve();
}

function sRenderDay() {
  const el = document.getElementById('day-chip');
  if (el) el.textContent = S.summary ? `Simulated day ${S.summary.day}` : '';
}

function sRenderVersions() {
  const el = document.getElementById('versions');
  const vs = (S.policy && S.policy.versions) || [];
  el.innerHTML = vs.map(v => {
    const on = v.id === S.policy.version;
    const note = String(v.note || '').replace(new RegExp('^' + v.id + ':\\s*'), '');
    return `<button data-version="${esc(v.id)}" class="ver${on ? ' on' : ''}">
      <div class="vt"><span class="vname">Policy ${esc(v.id)}</span>
        <span class="vstate">${on ? `active · <span class="mono" style="text-transform:none;letter-spacing:0">#${esc(S.policy.hash)}</span>` : 'switch →'}</span></div>
      <div class="vnote">${esc(note)}</div>
    </button>`;
  }).join('');
}

function sRenderRules() {
  const el = document.getElementById('rules');
  const rules = (S.policy && S.policy.rules) || [];
  const active = rules.filter(r => r.active).length;
  document.getElementById('rules-sub').textContent = `${active} of ${rules.length} rules on in policy ${S.policy.version}`;
  el.innerHTML = rules.map(r => `
    <tr class="${r.active ? '' : 'rule-off'}">
      <td><span class="rule-text">${esc(r.text)}</span> <span class="ref">${esc(r.id)}</span></td>
      <td><span class="dec" style="color:${DECISION_COLOR[r.decision] || J.muted}">${esc(DECISION_LABEL[r.decision] || r.decision)}</span></td>
      <td><span class="cond">${esc(r.condition || '')}</span></td>
      <td class="r"><span class="onoff" style="color:${r.active ? J.green : J.faint}">${r.active ? '● on' : '○ off'}</span></td>
    </tr>`).join('');
}

function worstCaseHTML(prove) {
  const wc = prove && prove.worst_case;
  const t1 = prove && (prove.theorems || []).find(t => t.id === 'T1');
  const capCaption = 'Most an agent could ever spend without a human in 30 days (computed by the prover)';
  let value, cap = capCaption, src = '', over = false;
  if (t1 && t1.status === 'attack' && wc && (wc.status === 'optimal' || wc.status === 'timeout')) {
    // The optimiser only hit the prover's own payment limit; the honest statement is "over the cap".
    value = '&gt; £5,000';
    over = true;
    cap = 'No ceiling below the £5,000 cap: the prover found a loophole (see Theorem T1)';
    src = wc.bound_by ? `£${(wc.upper_bound / 100).toLocaleString('en-GB')} is only the prover's limit (${esc(wc.bound_by)})` : '';
  } else if (wc && wc.status === 'optimal' && wc.value != null) {
    value = fmtGBP(wc.value);
    over = t1 && t1.status === 'attack';
    const bits = [];
    if (wc.upper_bound != null && wc.bound_by) {
      const by = /PO limits/.test(wc.bound_by) ? 'the sum of open purchase-order limits'
        : /payments ×/.test(wc.bound_by) ? `${wc.bound_by} (the prover's payment limit)` : wc.bound_by;
      bits.push(`ceiling ${fmtGBP(wc.upper_bound)}: ${esc(by)}`);
    }
    if (wc.seconds != null) bits.push(`${Number(wc.seconds).toFixed(1)} s`);
    src = bits.join(' · ');
  } else if (wc && wc.status === 'timeout' && t1 && t1.status === 'proved') {
    value = `≤ ${fmtGBP(wc.upper_bound != null && wc.upper_bound < 500000 ? wc.upper_bound : 500000)}`;
    cap = 'Most an agent could ever spend without a human in 30 days (guaranteed cap)';
    src = wc.bound_by ? `bound from ${esc(wc.bound_by)}` : 'guaranteed by the £5,000 rule, which is proven above';
  } else if (wc && wc.status === 'timeout') {
    value = wc.upper_bound != null ? `≤ ${fmtGBP(wc.upper_bound)}` : 'Timed out';
    src = wc.bound_by ? `bound from ${esc(wc.bound_by)}; the exact maximum timed out` : 'the optimiser hit its time limit';
  } else if (wc && wc.status === 'error') {
    value = '—';
    src = 'the optimiser failed';
  } else {
    value = '<span class="faint" style="font-size:32px;font-style:italic;font-weight:400"><span class="spin"></span> computing…</span>';
  }
  return `<div class="lbl">Worst-case unapproved spend</div>
    <div class="val tnum${over ? ' over' : ''}">${value}</div>
    <div class="cap">${cap}</div>
    ${src ? `<div class="src">${src}</div>` : ''}`;
}

function sRenderProve() {
  const prove = S.prove;
  updateHeader({ policy: S.policy, prove, summary: S.summary });
  document.getElementById('worst').innerHTML = worstCaseHTML(prove);

  const ts = (prove && prove.theorems) || [];
  const c = proveCounts(prove);
  const running = prove && prove.running;
  const btn = document.getElementById('btn-prove');
  btn.disabled = !!running;
  btn.innerHTML = running ? '<span class="spin"></span> Proving…' : 'Run prover';

  const sub = document.getElementById('thm-sub');
  if (!ts.length) sub.textContent = 'Not checked yet for this version.';
  else sub.innerHTML = `${c.proved} of ${c.total} proven${c.failing ? ` · <span style="color:${J.red}">${c.failing} loophole${c.failing > 1 ? 's' : ''} found</span>` : ''}`;

  const note = document.getElementById('thm-note');
  note.textContent = ts.length
    ? `Proven for up to ${prove.n || 60} payments per 30-day window against the current purchase orders.`
    : '';

  // drop the overlay if its theorem no longer has an attack
  if (S.attackId && !ts.find(t => t.id === S.attackId && t.status === 'attack' && t.counterexample)) S.attackId = null;

  const el = document.getElementById('theorems');
  if (!ts.length) {
    el.innerHTML = `<li class="thm-empty">${running ? '<span class="spin"></span> Starting the prover…' : 'Click <b>Run prover</b> to check this policy.'}</li>`;
  } else {
    el.innerHTML = ts.map(t => {
      const st = t.status || 'pending';
      const [label, cls] = THM_STATUS[st] || [esc(st), 'pending'];
      const showing = S.attackId === t.id;
      const ce = t.counterexample;
      const plain = THM_PLAIN[t.id] || t.statement;
      return `<li class="thm${showing ? ' showing' : ''}">
        <div class="body">
          <div class="stmt">${esc(plain)}</div>
          <div class="meta">
            <span class="st ${cls}">${label}</span>
            ${t.seconds != null ? `<span class="secs">${Number(t.seconds).toFixed(1)} s</span>` : ''}
            <span class="ref" title="${esc(t.statement || '')}">${esc(t.id)}</span>
          </div>
          ${st === 'attack' && ce && ce.summary ? `<div class="why">${esc(ce.summary)}</div>` : ''}
        </div>
        ${st === 'attack' && ce && (ce.payments || []).length ? `<button data-attack="${esc(t.id)}" class="btn btn-red${showing ? ' on' : ''}" style="flex-shrink:0">${showing ? 'Hide attack' : 'Show attack'}</button>` : ''}
      </li>`;
    }).join('');
  }
  sRenderAttack();
  sRenderMap();
}

function sAttack() {
  if (!S.attackId || !S.prove) return null;
  const t = (S.prove.theorems || []).find(x => x.id === S.attackId);
  return t && t.counterexample ? Object.assign({ theorem: t }, t.counterexample) : null;
}

function sRenderAttack() {
  const a = sAttack();
  const chip = document.getElementById('attack-chip');
  const box = document.getElementById('attack-box');
  if (!a) {
    chip.innerHTML = S.policy
      ? (p8Active(S.policy) ? '£5,000 cap enforced <span class="ref">P8</span>' : `<span style="color:${J.red}">£5,000 cap not enforced</span> <span class="ref">no P8</span>`)
      : '';
    box.innerHTML = '';
    return;
  }
  const plain = THM_PLAIN[a.theorem.id] || a.theorem.statement;
  chip.innerHTML = `<span style="color:${J.red}">Showing the loophole in ${esc(a.theorem.id)}</span>`;
  let cum = 0;
  const rows = (a.payments || []).map((p, i) => {
    const before = cum;
    if (p.auto) cum += p.amount;
    return `<tr>
      <td class="faint tnum">${i + 1}</td>
      <td class="tnum">${esc(p.day)}</td>
      <td>${esc(p.vendor)}</td>
      <td class="mono">${esc(p.po || '—')}</td>
      <td class="mono faint">${esc(p.invoice_id)}</td>
      <td class="r tnum" style="font-weight:600">${fmtGBP(p.amount)}</td>
      <td class="c">${p.auto ? `<span style="color:${J.red}">automatic</span>` : '<span class="faint">human</span>'}</td>
      <td class="r tnum${before > 500000 ? ' over' : ''}">${fmtGBP(before)}</td></tr>`;
  }).join('');
  box.innerHTML = `<div class="attack">
    <h3>Loophole: “${esc(plain)}” does not hold</h3>
    <div class="sub">${esc(a.summary || '')} — ${(a.payments || []).length} payments this policy allows, in order; ${fmtGBP(cum)} paid with no human involved.</div>
    <div class="scroller">
      <table class="bk">
        <thead><tr><th>#</th><th>Day</th><th>Vendor</th><th>PO</th><th>Invoice</th><th class="r">Amount</th><th class="c">Paid</th><th class="r">Unapproved spend before</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div class="caption"><b>Table 2.</b> A sequence of payments found by the prover. Every row passes the active policy; together they break the guarantee.</div>
  </div>`;
}

// ------------------------------------------------------------ policy map --
// x: payment amount (£0–600), y: unapproved (auto) spend in the 30 days before it.

function drawPolicyMap(el, opts) {
  if (!el || !window.Plotly) return;
  const { payments = [], attack = null, p8 = true, cap = 500000 } = opts || {};
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
    attackPts.forEach(pt => ys.push(pt.y));
    ys.push(cum / 100);
    attackPts.total = cum;
  }

  const yTop = Math.max(8000, ...ys.map(y => y * 1.08));

  const shapes = [
    { type: 'rect', xref: 'x', yref: 'y', x0: 0, x1: 100, y0: 0, y1: yTop, fillcolor: 'rgba(47,111,79,0.08)', line: { width: 0 }, layer: 'below' },
    { type: 'rect', xref: 'x', yref: 'y', x0: 100, x1: 500, y0: 0, y1: yTop, fillcolor: 'rgba(184,134,43,0.08)', line: { width: 0 }, layer: 'below' },
    { type: 'rect', xref: 'x', yref: 'y', x0: 500, x1: XMAX, y0: 0, y1: yTop, fillcolor: 'rgba(163,48,42,0.08)', line: { width: 0 }, layer: 'below' },
    { type: 'line', xref: 'x', yref: 'y', x0: 0, x1: XMAX, y0: capY, y1: capY,
      line: { color: p8 ? J.ink2 : J.red, width: 1.5, dash: 'dash' } },
  ];
  if (p8) shapes.push({ type: 'rect', xref: 'x', yref: 'y', x0: 0, x1: 500, y0: capY, y1: yTop, fillcolor: 'rgba(184,134,43,0.07)', line: { width: 0 }, layer: 'below' });

  const serif = "'Source Serif 4', Georgia, serif";
  const annotations = [
    { x: 50, y: yTop, yanchor: 'top', text: '<i>paid automatically</i><br>≤ £100', showarrow: false, font: { family: serif, size: 12, color: J.green } },
    { x: 300, y: yTop, yanchor: 'top', text: '<i>held for approval</i><br>£100–£500', showarrow: false, font: { family: serif, size: 12, color: J.amberInk } },
    { x: 550, y: yTop, yanchor: 'top', text: '<i>blocked</i><br>over £500', showarrow: false, font: { family: serif, size: 12, color: J.red } },
    { x: XMAX, y: capY, xanchor: 'right', yanchor: 'bottom', showarrow: false,
      text: p8 ? '<i>£5,000 cap</i>' : '<i>intended £5,000 cap (not enforced)</i>',
      font: { family: serif, size: 12, color: p8 ? J.ink2 : J.red } },
  ];

  const traces = [];
  for (const d of ['allow', 'escrow', 'hold', 'block']) {
    const pts = byDecision[d];
    traces.push({
      type: 'scatter', mode: 'markers', name: { allow: 'Paid', escrow: 'Escrow', hold: 'Held', block: 'Blocked' }[d],
      x: pts.map(q => q.x), y: pts.map(q => q.y),
      text: pts.map(q => `<b>${esc(q.p.invoice?.invoice_id || q.p.proposal?.invoice_id || q.p.id)}</b> · ${esc(q.p.vendor_name || '')}<br>${fmtGBP(q.p.amount)}${q.clipped ? ' (off chart)' : ''} · ${esc(STATUS_LABEL[q.p.status] || q.p.status)}<br>unapproved spend before: ${fmtGBP(q.p.auto_spend_before || 0)}`),
      hovertemplate: '%{text}<extra></extra>',
      marker: {
        color: DECISION_COLOR[d], size: 10,
        symbol: pts.map(q => q.clipped ? 'triangle-right' : 'circle'),
        line: { color: J.paper, width: 1.5 }, opacity: 0.95,
      },
    });
  }

  if (attackPts && attackPts.length) {
    traces.push({
      type: 'scatter', mode: 'lines+markers', name: 'Loophole path',
      x: attackPts.map(p => p.x), y: attackPts.map(p => p.y),
      line: { color: J.red, width: 1.6 },
      marker: { color: attackPts.map(p => p.a.auto ? J.red : '#d9a29e'), size: 6, line: { color: J.paper, width: 1 } },
      text: attackPts.map(p => `Payment ${p.i + 1} · day ${p.a.day} · ${esc(p.a.vendor)}${p.a.po ? ' · ' + esc(p.a.po) : ''}<br>${fmtGBP(p.a.amount)} ${p.a.auto ? '(automatic)' : '(approved by a human)'}<br>unapproved spend before: ${fmtGBP(Math.round(p.y * 100))}`),
      hovertemplate: '%{text}<extra></extra>',
    });
    const last = attackPts[attackPts.length - 1];
    annotations.push({
      x: last.x, y: attackPts.total / 100, ax: 50, ay: -24, showarrow: true, arrowhead: 2, arrowcolor: J.red,
      text: `<b>${fmtGBP(attackPts.total)} unapproved</b>`, font: { family: serif, color: J.red, size: 13 },
      bgcolor: 'rgba(253,252,248,0.92)', bordercolor: J.red, borderwidth: 0.5, borderpad: 3,
    });
  }

  const layout = {
    height: el.clientHeight || 480,
    autosize: true,
    margin: { l: 66, r: 14, t: 14, b: 50 },
    paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: J.paper,
    font: { family: serif, color: J.ink2, size: 13 },
    xaxis: { range: [0, XMAX], title: { text: 'Payment amount', standoff: 8 }, tickprefix: '£', tickvals: [0, 100, 200, 300, 400, 500, 600],
      gridcolor: J.track, zeroline: false, fixedrange: true, linecolor: J.ink, showline: true, ticks: 'outside', tickcolor: J.ink, ticklen: 4,
      tickfont: { family: 'Inter, sans-serif', size: 11, color: J.muted } },
    yaxis: { range: [0, yTop], title: { text: 'Unapproved spend in prior 30 days', standoff: 6 }, tickprefix: '£', tickformat: ',.0f',
      gridcolor: J.track, zeroline: false, fixedrange: true, linecolor: J.ink, showline: true, ticks: 'outside', tickcolor: J.ink, ticklen: 4,
      tickfont: { family: 'Inter, sans-serif', size: 11, color: J.muted } },
    shapes, annotations,
    showlegend: true,
    legend: { orientation: 'h', x: 0, y: -0.15, font: { size: 12, color: J.ink2 } },
    hoverlabel: { bgcolor: J.ink, bordercolor: J.ink, font: { color: J.paper, family: 'Inter, sans-serif', size: 12 } },
  };
  Plotly.react(el, traces, layout, { displayModeBar: false, responsive: true });
}

function sRenderMap() {
  const attack = sAttack();
  drawPolicyMap(document.getElementById('map'), {
    payments: S.payments, attack, p8: p8Active(S.policy),
    cap: (S.summary && S.summary.auto_cap) || 500000,
  });
  const cap = document.getElementById('map-caption');
  if (cap) cap.innerHTML = `<b>Fig. 1 —</b> Each dot is a real payment, placed by its size and by how much was already paid without approval in the 30 days before it; the shading shows what the active policy does in each region.${attack ? ` The red line is the loophole the prover found: payments in order, each one allowed, adding up to ${fmtGBP(attack.payments ? attack.payments.reduce((s, p) => s + (p.auto ? p.amount : 0), 0) : 0)} without a human.` : ''}`;
}

// ------------------------------------------------------------ actions --

async function sSetVersion(v) {
  if (!S.policy || v === S.policy.version) return;
  try {
    S.policy = await api('POST', '/api/policy/version', { version: v });
    S.attackId = null;
    if (S.proveTimer) { clearInterval(S.proveTimer); S.proveTimer = null; }
    S.prove = null;
    sRenderVersions(); sRenderRules(); sRenderProve();
    toast(`Policy ${v} active. The gate and the prover now use it.`);
    await sLoadAll();
  } catch (e) { toast(e.message || String(e), 'red'); }
}

async function sRunProver() {
  try {
    const v = S.policy.version;
    const r = await api('POST', '/api/prove', { version: v });
    if (r && S.policy.version === v) {
      S.prove = Object.assign({}, r, { running: r.running !== false });
      sRenderProve();
    }
    if (S.proveTimer) { clearInterval(S.proveTimer); S.proveTimer = null; }
    sMaybePollProve();
  } catch (e) { toast(e.message || String(e), 'red'); }
}

function initSettings() {
  renderHeader();
  document.getElementById('versions').addEventListener('click', e => {
    const b = e.target.closest('[data-version]');
    if (b) sSetVersion(b.dataset.version);
  });
  document.getElementById('theorems').addEventListener('click', e => {
    const b = e.target.closest('[data-attack]');
    if (!b) return;
    S.attackId = S.attackId === b.dataset.attack ? null : b.dataset.attack;
    sRenderProve();
  });
  document.getElementById('btn-prove').addEventListener('click', sRunProver);
  document.getElementById('btn-day').addEventListener('click', async () => {
    try { S.summary = await api('POST', '/api/day/advance'); sRenderDay(); updateHeader({ policy: S.policy, prove: S.prove, summary: S.summary }); toast(`Day ${S.summary.day}`); }
    catch (e) { toast(e.message || String(e), 'red'); }
  });
  document.getElementById('btn-reset').addEventListener('click', async () => {
    if (!confirm('Reset the demo? This clears all payments (the prover cache is kept).')) return;
    try { S.summary = await api('POST', '/api/reset'); S.payments = []; sRenderDay(); sRenderMap(); toast('Demo reset'); sLight(); }
    catch (e) { toast(e.message || String(e), 'red'); }
  });
  sLoadAll();
  setInterval(sLight, 3000);
}

initSettings();
