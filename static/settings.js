/* Proven — Policies page: rules grouped into categories, plus proven guarantees.
 * Self-contained (does not load app.js). Rule and theorem text come from the API. */

const MOCK = new URLSearchParams(location.search).has('mock');

async function api(method, path) {
  if (MOCK && window.MockAPI) return window.MockAPI.handle(method, path);
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const CATEGORIES = [
  { title: 'Billing integrity', desc: 'Stops duplicate and over-billed invoices.', ids: ['P4', 'P10'] },
  { title: 'Purchase orders & matters', desc: 'Every payment must trace to an approved purchase order.', ids: ['P9'] },
  { title: 'Spending limits', desc: 'Caps on single payments, daily vendor totals and unapproved spend.', ids: ['P5', 'P6', 'P7', 'P8'] },
  { title: 'AI spend', desc: 'Payments to AI agents and AI services.', ids: ['P11'] },
  { title: 'Segregation of duties', desc: 'Who may approve what.', ids: ['P12'] },
];

function chip(rule) {
  if (rule.id === 'P12') return '<span class="chip c-approval">Approval rule</span>';
  const m = { block: ['c-block', 'Refuse'], hold: ['c-hold', 'Needs approval'], escrow: ['c-escrow', 'Escrow'] }[rule.decision];
  return m ? `<span class="chip ${m[0]}">${m[1]}</span>` : '';
}

const S = { policy: null, prove: null, summary: null, err: null };

function render() {
  renderProvenHeader('policies', S.summary && S.summary.stripe_mode);
  document.getElementById('conn').innerHTML = S.err ? `<div class="err">Cannot reach the server (${esc(S.err)}). Retrying…</div>` : '';
  if (S.policy) {
    const rules = (S.policy.rules || []).filter(r => r.active);
    const byId = Object.fromEntries(rules.map(r => [r.id, r]));
    const cards = CATEGORIES.map(c => {
      const rs = c.ids.map(id => byId[id]).filter(Boolean);
      if (!rs.length) return '';
      return `<div class="card"><h3>${esc(c.title)}</h3><p class="desc">${esc(c.desc)}</p>
        ${rs.map(r => `<div class="rule"><span>${esc(r.text)}</span>${chip(r)}</div>`).join('')}</div>`;
    }).join('');
    document.getElementById('cards').innerHTML = cards || '<div class="empty">No active rules.</div>';
  }
  const ts = ((S.prove && S.prove.theorems) || []).filter(t => t.status === 'proved');
  document.getElementById('theorems').innerHTML = ts.length
    ? ts.map(t => `<li><span>${esc(t.statement)}</span><span class="chip c-proved">Proven ✓</span></li>`).join('')
    : `<li class="empty" style="display:block">${S.prove ? 'Proving…' : 'Loading…'}</li>`;
}

async function refresh() {
  try {
    const [policy, summary] = await Promise.all([api('GET', '/api/policy'), api('GET', '/api/summary').catch(() => null)]);
    S.policy = policy; S.summary = summary; S.err = null;
    S.prove = await api('GET', '/api/prove?version=' + encodeURIComponent(policy.version || ''));
  } catch (e) { S.err = e.message; }
  render();
}

render();
refresh();
setInterval(refresh, 5000);
