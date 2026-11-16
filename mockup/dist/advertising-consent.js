'use strict';
(() => {
  const panel = document.querySelector('#advertising-consent');
  if (!panel) return;
  const storageKey = 'rael-advertising-consent';
  const url = new URL(location.href);
  const clicks = {};
  for (const field of ['fbclid', 'gclid', 'gbraid', 'wbraid']) {
    const value = url.searchParams.get(field);
    if (value && /^[A-Za-z0-9_.-]{8,256}$/.test(value)) clicks[field] = value;
    url.searchParams.delete(field);
  }
  if (url.href !== location.href) history.replaceState(null, '', url.href);
  const current = panel.dataset.ref;
  let previous;
  try { previous = sessionStorage.getItem(storageKey); } catch {}
  const status = panel.querySelector('[data-advertising-status]');
  const allow = panel.querySelector('[data-choice="allow"]');
  const deny = panel.querySelector('[data-choice="deny"]');
  if (!previous && !Object.keys(clicks).length) return;
  panel.hidden = false;
  function render() {
    allow.hidden = Boolean(previous) || !Object.keys(clicks).length;
    deny.textContent = previous ? 'Retirar permissão' : 'Recusar';
  }
  render();
  async function save(decision) {
    if (decision === 'deny' && !previous) {
      panel.hidden = true;
      return;
    }
    allow.disabled = deny.disabled = true;
    try {
      const reply = await fetch('/api/v1/advertising-consent', {
        method: 'POST', cache: 'no-store', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(decision === 'allow' ? { ref: current, decision, clicks } : { ref: previous, decision })
      });
      if (!reply.ok) throw new Error();
      previous = decision === 'allow' ? current : null;
      try {
        if (previous) sessionStorage.setItem(storageKey, previous);
        else sessionStorage.removeItem(storageKey);
      } catch {}
      status.textContent = previous ? 'Permissão registrada para este acesso.' : 'Permissão retirada.';
      render();
      if (!previous) allow.hidden = deny.hidden = true;
    } catch {
      status.textContent = 'Não foi possível registrar a preferência agora. Tente novamente.';
    } finally {
      allow.disabled = deny.disabled = false;
    }
  }
  allow.addEventListener('click', () => save('allow'));
  deny.addEventListener('click', () => save('deny'));
})();
