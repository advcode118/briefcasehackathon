/* Proven — shared header for Payments and Policies. renderProvenHeader(active, stripeMode). */
(function () {
  const css = `
  .pv-hdr { font-family: 'Source Serif 4', Georgia, serif; }
  .pv-row { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 10px 24px; }
  .pv-brand { font-size: 32px; font-weight: 600; letter-spacing: -.01em; color: #1a1a1a; text-decoration: none; line-height: 1; }
  .pv-tag { font-style: italic; color: #6b6457; font-size: 14px; margin-left: 10px; }
  .pv-right { display: flex; align-items: flex-end; gap: 18px; }
  .pv-nav { display: flex; gap: 4px; font-family: Inter, system-ui, sans-serif; font-size: 14px; font-weight: 500; }
  .pv-nav a { color: #6b6457; text-decoration: none; padding: 6px 12px 8px; border-bottom: 2px solid transparent; }
  .pv-nav a:hover { color: #1a1a1a; }
  .pv-nav a.on { color: #1a1a1a; border-bottom-color: #1a1a1a; }
  .pv-pill { font-family: Inter, system-ui, sans-serif; font-size: 11px; font-weight: 500; color: #3c5a8a; border: 1px solid #c3cde0; border-radius: 999px; padding: 2px 9px; margin-bottom: 8px; white-space: nowrap; }
  .pv-rule { margin-top: 0; border-top: 2px solid #1a1a1a; }
  .pv-rule2 { margin-top: 2px; border-top: 1px solid #1a1a1a; }`;
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
  window.renderProvenHeader = function (active, stripeMode) {
    const el = document.getElementById('masthead');
    if (!el) return;
    const q = new URLSearchParams(location.search).has('mock') ? '?mock=1' : '';
    const pill = stripeMode === 'test' ? '<span class="pv-pill">Stripe test mode</span>' : '';
    const html = `<div class="pv-hdr"><div class="pv-row">
        <div style="padding-bottom:8px"><a class="pv-brand" href="/${q}">Proven</a><span class="pv-tag">proven, not prompted</span></div>
        <div class="pv-right">${pill}<nav class="pv-nav">
          <a href="/${q}" class="${active === 'payments' ? 'on' : ''}">Payments</a>
          <a href="/settings${q}" class="${active === 'policies' ? 'on' : ''}">Policies</a></nav></div></div>
      <div class="pv-rule"></div><div class="pv-rule2"></div></div>`;
    if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; }
  };
})();
