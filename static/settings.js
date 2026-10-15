/* Proven — settings page: version selector, rules, theorems, policy map. Uses helpers from app.js. */

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

function sRenderConn() {
  const el = document.getElementById('conn');
  if (!el) return;
  el.innerHTML = S.error
    ? `<div class="mx-auto mt-4 max-w-[1400px] px-6"><div class="flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800">
       <span class="h-2 w-2 animate-pulse rounded-full bg-amber-500"></span>Waiting for the API… <span class="font-mono text-xs text-amber-700/80">${esc(S.error)}</span></div></div>`
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
    return `<button data-version="${esc(v.id)}" class="group rounded-2xl p-4 text-left transition ${on
        ? 'bg-slate-900 text-white shadow-md ring-2 ring-slate-900'
        : 'bg-white text-slate-900 shadow-sm ring-1 ring-slate-200 hover:ring-slate-400'}">
      <div class="flex items-center justify-between">
        <span class="text-lg font-semibold tracking-tight">Policy ${esc(v.id)}</span>
        ${on ? `<span class="rounded-full bg-white/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white">active · <span class="font-mono normal-case">#${esc(S.policy.hash)}</span></span>`
             : '<span class="text-[11px] font-medium text-slate-400 group-hover:text-slate-600">switch →</span>'}
      </div>
      <div class="mt-1 text-[13px] leading-snug ${on ? 'text-slate-300' : 'text-slate-500'}">${esc(v.note)}</div>
    </button>`;
  }).join('');
}

function sRenderRules() {
  const el = document.getElementById('rules');
  const rules = (S.policy && S.policy.rules) || [];
  const active = rules.filter(r => r.active).length;
  document.getElementById('rules-sub').textContent = `${active} of ${rules.length} rules on in ${S.policy.version}`;
  el.innerHTML = rules.map(r => `
    <tr class="border-t border-slate-100 ${r.active ? '' : 'bg-slate-50/60'}">
      <td class="py-3 pl-5 pr-3 align-top">${r.active ? ruleChip(r.id, r.decision) : `<span class="font-mono text-[11px] font-semibold text-slate-400">${esc(r.id)}</span>`}</td>
      <td class="px-3 py-3 align-top text-sm ${r.active ? 'font-medium text-slate-900' : 'text-slate-400 line-through decoration-slate-300'}">${esc(r.text)}</td>
      <td class="px-3 py-3 align-top"><span class="text-xs font-semibold uppercase tracking-wide ${r.active ? '' : 'opacity-40'}" style="color:${DECISION_COLOR[r.decision] || '#7c3aed'}">${esc(DECISION_LABEL[r.decision] || r.decision)}</span></td>
      <td class="px-3 py-3 align-top font-mono text-[12px] ${r.active ? 'text-slate-700' : 'text-slate-400'}">${esc(r.condition || '')}</td>
      <td class="py-3 pl-3 pr-5 text-right align-top">${r.active
        ? '<span class="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-200">● on</span>'
        : '<span class="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-400 ring-1 ring-inset ring-slate-200">○ off</span>'}</td>
    </tr>`).join('');
}

const THM_ICON = {
  proved: '<span class="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-emerald-500 text-xs font-bold text-white">✓</span>',
  attack: '<span class="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-red-500 text-xs font-bold text-white">✗</span>',
  timeout: '<span class="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-amber-100 text-xs">⏱</span>',
  error: '<span class="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-slate-200 text-xs font-bold text-slate-600">!</span>',
  pending: '<span class="grid h-6 w-6 shrink-0 place-items-center"><span class="spin inline-block h-4 w-4 rounded-full border-2 border-slate-300 border-t-transparent"></span></span>',
};
const THM_LABEL = { proved: 'proved', attack: 'attack found', timeout: 'timeout', error: 'error', pending: 'proving…' };

function sRenderProve() {
  const prove = S.prove;
  updateHeader({ policy: S.policy, prove, summary: S.summary });
  document.getElementById('worst').innerHTML = worstCaseHTML(prove, (S.summary && S.summary.auto_cap) || 500000);

  const ts = (prove && prove.theorems) || [];
  const c = proveCounts(prove);
  const running = prove && prove.running;
  const btn = document.getElementById('btn-prove');
  btn.disabled = !!running;
  btn.innerHTML = running ? '<span class="spin inline-block h-3.5 w-3.5 rounded-full border-2 border-white/60 border-t-transparent"></span>Proving…' : 'Run prover';

  const sub = document.getElementById('thm-sub');
  if (!ts.length) sub.textContent = 'Not run yet for this version.';
  else sub.innerHTML = `${c.proved}/${c.total} proved${c.failing ? ` · <span class="font-semibold text-red-600">${c.failing} attack${c.failing > 1 ? 's' : ''} found</span>` : ''} · bounded: up to ${esc(prove.n || 60)} payments / 30 days`;

  // drop the overlay if its theorem no longer has an attack
  if (S.attackId && !ts.find(t => t.id === S.attackId && t.status === 'attack' && t.counterexample)) S.attackId = null;

  const el = document.getElementById('theorems');
  if (!ts.length) {
    el.innerHTML = `<li class="px-5 py-10 text-center text-sm text-slate-400">${running ? 'Starting the prover…' : 'Click <b>Run prover</b> to check this policy.'}</li>`;
  } else {
    el.innerHTML = ts.map(t => {
      const st = t.status || 'pending';
      const showing = S.attackId === t.id;
      const ce = t.counterexample;
      return `<li class="px-5 py-3.5 ${showing ? 'bg-red-50/70' : ''}">
        <div class="flex items-start gap-3">${THM_ICON[st] || THM_ICON.pending}
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-baseline gap-x-2">
              <span class="font-mono text-xs font-bold text-slate-900">${esc(t.id)}</span>
              <span class="text-sm font-medium text-slate-800">${esc(t.statement)}</span>
            </div>
            <div class="mt-0.5 text-xs ${st === 'attack' ? 'text-red-600' : st === 'proved' ? 'text-emerald-700' : 'text-slate-400'}">
              ${THM_LABEL[st] || esc(st)}${t.seconds != null ? ` <span class="text-slate-400">· ${Number(t.seconds).toFixed(1)} s</span>` : ''}
            </div>
            ${st === 'attack' && ce && ce.summary ? `<div class="mt-1 text-[13px] text-red-800">${esc(ce.summary)}</div>` : ''}
          </div>
          ${st === 'attack' && ce && (ce.payments || []).length ? `<button data-attack="${esc(t.id)}" class="btn shrink-0 ${showing ? 'bg-red-600 text-white hover:bg-red-700' : 'bg-white text-red-700 ring-1 ring-inset ring-red-300 hover:bg-red-50'} px-3 py-1 text-xs">${showing ? 'Hide attack' : 'Show attack'}</button>` : ''}
        </div></li>`;
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
    chip.innerHTML = S.policy ? `<span class="rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1 ring-inset ${p8Active(S.policy) ? 'bg-slate-100 text-slate-600 ring-slate-200' : 'bg-red-50 text-red-700 ring-red-200'}">${p8Active(S.policy) ? 'P8 cap enforced' : 'no P8: £5,000 cap not enforced'}</span>` : '';
    box.innerHTML = '';
    return;
  }
  chip.innerHTML = `<span class="inline-flex items-center gap-1.5 rounded-full bg-red-600 px-2.5 py-1 text-[11px] font-semibold text-white"><span class="h-1.5 w-1.5 rounded-full bg-white"></span>Showing ${esc(a.theorem.id)} attack</span>`;
  let cum = 0;
  const rows = (a.payments || []).map((p, i) => {
    const before = cum;
    if (p.auto) cum += p.amount;
    return `<tr class="border-t border-red-100/70">
      <td class="py-1.5 pl-5 pr-2 text-slate-400 tabular-nums">${i + 1}</td>
      <td class="px-2 py-1.5 tabular-nums">${esc(p.day)}</td>
      <td class="px-2 py-1.5">${esc(p.vendor)}</td>
      <td class="px-2 py-1.5 font-mono">${esc(p.po || '—')}</td>
      <td class="px-2 py-1.5 font-mono text-slate-500">${esc(p.invoice_id)}</td>
      <td class="px-2 py-1.5 text-right font-semibold tabular-nums">${fmtGBP(p.amount)}</td>
      <td class="px-2 py-1.5 text-center">${p.auto ? '<span class="text-red-600">auto</span>' : '<span class="text-slate-400">human</span>'}</td>
      <td class="py-1.5 pl-2 pr-5 text-right tabular-nums ${before > 500000 ? 'font-semibold text-red-600' : 'text-slate-600'}">${fmtGBP(before)}</td></tr>`;
  }).join('');
  box.innerHTML = `<div class="border-t border-red-100 bg-red-50/40">
    <div class="flex flex-wrap items-baseline justify-between gap-2 px-5 pb-2 pt-3">
      <div class="text-sm font-semibold text-red-800">${esc(a.theorem.id)} counterexample · ${esc(a.summary || '')}</div>
      <div class="text-xs text-red-700/70">${(a.payments || []).length} payments the policy allows, in order · total auto ${fmtGBP(cum)}</div>
    </div>
    <div class="max-h-64 overflow-y-auto">
      <table class="w-full text-left text-xs text-slate-700">
        <thead class="sticky top-0 bg-red-50 text-[10px] font-semibold uppercase tracking-wider text-red-700/70">
          <tr><th class="py-1.5 pl-5 pr-2">#</th><th class="px-2 py-1.5">Day</th><th class="px-2 py-1.5">Vendor</th><th class="px-2 py-1.5">PO</th><th class="px-2 py-1.5">Invoice</th><th class="px-2 py-1.5 text-right">Amount</th><th class="px-2 py-1.5 text-center">Executed</th><th class="py-1.5 pl-2 pr-5 text-right">Auto spend before</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div></div>`;
}

function sRenderMap() {
  drawPolicyMap(document.getElementById('map'), {
    payments: S.payments, attack: sAttack(), p8: p8Active(S.policy),
    cap: (S.summary && S.summary.auto_cap) || 500000,
  });
}

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
  renderHeader('settings');
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
