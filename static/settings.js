/* ProofPay — Policies page: rules grouped by their API `category`, plus proven guarantees.
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

const S = { policy: null, prove: null, summary: null, err: null };

function render() {
  renderProvenHeader('policies');
  document.getElementById('conn').innerHTML = S.err ? `<div class="err">Cannot reach the server (${esc(S.err)}). Retrying…</div>` : '';
  if (S.policy) {
    const rules = (S.policy.rules || []).filter(r => r.active);
    const groups = new Map(); // insertion order = order categories first appear in the API list
    for (const r of rules) {
      const cat = r.category || 'General';
      if (!groups.has(cat)) groups.set(cat, { note: r.category_note || '', rules: [] });
      const g = groups.get(cat);
      if (!g.note && r.category_note) g.note = r.category_note;
      g.rules.push(r);
    }
    const cards = [...groups].map(([title, g]) => `<div class="card"><h3>${esc(title)}</h3>${g.note ? `<p class="desc">${esc(g.note)}</p>` : '<div style="height:10px"></div>'}
        ${g.rules.map(r => `<div class="rule"><span>${esc(r.text)}</span></div>`).join('')}</div>`).join('');
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
