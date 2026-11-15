"use strict";
(() => {
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const bell = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></svg>';
  const pollDelay = 45000;
  const requestTimeout = 12000;
  let current = null, modal = null, generation = 0, remembered = null;
  const active = state => current === state && state.active;
  const visible = () => document.visibilityState !== 'hidden';
  const prefix = state => `/internal/${encodeURIComponent(state.slug)}/${state.audience === 'customer' ? 'customer/' : ''}`;
  const control = (label, action, extra = '', secondary = true) => `<button type="button" class="rn-button${secondary ? ' rn-secondary' : ''}" data-rn-action="${action}" ${extra}>${label}</button>`;
  function safeUrl(value, state = current) {
    if (!state || typeof value !== 'string' || value.length > 2048 || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(value)) return null;
    try {
      const url = new URL(value, location.origin), tenant = encodeURIComponent(state.slug), staff = `/sistema/${tenant}`, booking = `/negocio/${tenant}`, plans = `/planos/${tenant}`;
      const paths = state.audience === 'customer' ? [booking, plans] : [staff, `${staff}/assinaturas`, `${staff}/assinatura`, `${staff}/painel`, booking, plans];
      if (/%(?:2f|5c)/i.test(url.pathname) || url.origin !== location.origin || url.username || url.password || !paths.includes(url.pathname)) return null;
      const query = new URLSearchParams();
      if (url.pathname === staff && state.audience === 'staff' && ['agenda', 'perfil'].includes(url.searchParams.get('visao'))) {
        query.set('visao', url.searchParams.get('visao'));
        const date = url.searchParams.get('data'), iso = /^\d{4}-\d{2}-\d{2}$/.test(date ?? '') && Number.isFinite(Date.parse(date + 'T12:00:00Z')) && new Date(date + 'T12:00:00Z').toISOString().slice(0, 10) === date;
        if (url.searchParams.get('visao') === 'agenda' && iso) query.set('data', date);
      }
      if (url.pathname === booking && url.searchParams.get('visao') === 'agendamentos') query.set('visao', 'agendamentos');
      return url.pathname + (query.size ? '?' + query : '');
    } catch { return null; }
  }
  function stopTimer(state) { if (state.timer) clearTimeout(state.timer); state.timer = null; }
  function schedule(state) {
    stopTimer(state);
    if (!active(state) || !visible() || state.stopped || state.failures >= 3) return;
    state.timer = setTimeout(() => feed(state), state.failures ? 60000 : pollDelay);
  }
  function buttonFor(state) { return document.querySelector('[data-rn-bell]'); }
  function drawBell(state) {
    if (!active(state)) return;
    const host = document.querySelector('[data-rael-notifications]'); if (!host) return; if (state.stopped) { host.innerHTML = ''; return; }
    const count = Math.max(0, Number(state.unreadCount) || 0), expanded = modal?.open === true;
    host.innerHTML = `<button type="button" class="rn-bell" data-rn-bell aria-label="Notificações${count ? ', ' + count + ' não lida(s)' : ''}" aria-haspopup="dialog" aria-controls="rael-notifications-panel" aria-expanded="${expanded}">${bell}${count ? `<span class="rn-count" aria-hidden="true">${count > 99 ? '99+' : count}</span>` : ''}</button>`;
  }
  function closePanel(returnFocus = true) {
    if (!modal) return;
    if (modal.open) modal.close();
    if (current) { current.restoreFocus = null; drawBell(current); }
    if (returnFocus && current) buttonFor(current)?.focus();
  }
  function unmount() {
    remembered = null;
    const previous = current; current = null; generation++;
    if (previous) { previous.active = false; stopTimer(previous); cancelPush(previous); previous.controller?.abort(); }
    if (modal) { if (modal.open) modal.close(); modal.remove(); modal = null; }
    for (const host of document.querySelectorAll('[data-rael-notifications]')) host.innerHTML = '';
  }
  function expire(state) {
    if (!active(state)) return;
    state.stopped = true; state.items = []; state.unreadCount = 0; stopTimer(state); cancelPush(state);
    closePanel(false); state.controller?.abort();
    for (const host of document.querySelectorAll('[data-rael-notifications]')) host.innerHTML = '';
  }
  async function api(state, path, data, signal) {
    if (!active(state) || state.stopped) throw Error('Acesso encerrado.');
    const csrf = state.csrf, binding = signal || state.controller?.signal;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const valid = () => active(state) && !state.stopped && state.csrf === csrf;
    const ended = () => Object.assign(Error('Acesso encerrado.'), { session: true });
    return new Promise((resolve, reject) => {
      let finished = false, timer;
      function finish(error, result) {
        if (finished) return; finished = true;
        if (timer) clearTimeout(timer); binding?.removeEventListener('abort', cancel);
        if (!valid()) error = ended();
        if (error) reject(error); else resolve(result);
      }
      function cancel() { finish(ended()); controller?.abort(); }
      timer = setTimeout(() => {
        finish(Error('A consulta demorou mais que o esperado. Tente novamente.'));
        controller?.abort();
      }, requestTimeout);
      binding?.addEventListener('abort', cancel, { once: true });
      if (binding?.aborted) { cancel(); return; }
      Promise.resolve().then(async () => {
        if (finished || !valid()) throw ended();
        const response = await fetch(prefix(state) + path, { credentials: 'same-origin', ...(controller || binding ? { signal: controller?.signal || binding } : {}), headers: { ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...(data ? { 'Content-Type': 'application/json' } : {}) }, ...(data ? { method: 'POST', body: JSON.stringify(data) } : {}) });
        if (finished || !valid()) throw ended();
        if (response.status === 401 || response.status === 403) { expire(state); throw Object.assign(Error('Seu acesso precisa ser atualizado. Entre novamente.'), { session: true }); }
        let result; try { result = await response.json(); } catch { throw Error('Não foi possível conferir o retorno. Tente novamente.'); }
        if (finished || !valid()) throw ended();
        if (!response.ok) throw Error(typeof result?.error === 'string' ? result.error : 'Não foi possível concluir. Tente novamente.');
        return result;
      }).then(result => finish(null, result), error => finish(error));
    });
  }
  function queue(state, task) {
    state.queue = state.queue.catch(() => {}).then(async () => { if (active(state) && !state.stopped) return task(); });
    return state.queue;
  }
  function date(value) { try { return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(Number(value)); } catch { return ''; } }
  function browserSupport() {
    const ios = /iPhone|iPad|iPod/i.test(navigator.userAgent ?? '') || navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
    if (ios && !navigator.standalone && !window.matchMedia?.('(display-mode: standalone)')?.matches) return { available: false, help: 'No iPhone ou iPad, adicione este site à Tela de Início pelo menu Compartilhar do Safari. Depois abra o ícone para ativar os avisos.' };
    if (window.isSecureContext === false || !navigator.serviceWorker || !window.Notification || !('PushManager' in window)) return { available: false, help: 'Este navegador não oferece avisos fora da página. A central continua disponível aqui.' };
    if (window.Notification.permission === 'denied') return { available: false, help: 'Os avisos estão bloqueados neste navegador. Libere as notificações nas configurações do site para ativar. A central continua disponível aqui.' };
    return { available: true, help: 'Receba avisos neste dispositivo mesmo com a página fechada, enquanto este acesso estiver válido. A permissão será pedida somente ao tocar em Ativar.' };
  }
  function settings(state) {
    const support = browserSupport(), enabled = state.config?.pushEnabled === true && window.Notification?.permission === 'granted';
    const permission = window.Notification?.permission, permissionLabel = permission === 'granted' ? 'permitida' : permission === 'denied' ? 'bloqueada' : permission === 'default' ? 'aguardando ativação' : 'indisponível';
    const disabled = !support.available || !state.config?.pushAvailable || state.mutating;
    return `<details id="rn-settings" class="rn-settings" ${state.settingsOpen ? 'open' : ''}><summary data-rn-focus="push-settings">Avisos neste navegador</summary><p>${esc(support.help)}</p><p>Permissão do navegador: <strong>${permissionLabel}</strong>.</p><p>Os avisos ficam ativos durante este acesso. Ao entrar novamente, ative neste navegador.</p>${state.config && !state.config.pushAvailable ? '<p>Os avisos fora da página ainda não estão disponíveis. Você pode acompanhar tudo nesta central.</p>' : ''}<div class="rn-row" aria-busy="${state.mutating}">${enabled ? '<span class="rn-enabled">Avisos ativos para este acesso</span>' + control('Desativar neste navegador', 'push-disable', `${state.mutating ? 'disabled' : ''} data-rn-focus="push-disable"`) + control('Enviar teste', 'push-test', `${state.mutating ? 'disabled' : ''} data-rn-focus="push-test"`) : control(state.pushAttempt && state.mutating ? 'Ativando…' : state.pushFailed ? 'Tentar ativar novamente' : 'Ativar neste navegador', 'push-enable', `${disabled ? 'disabled' : ''} data-rn-focus="push-enable"`, false)}</div><p class="rn-status" role="${state.pushFailed ? 'alert' : 'status'}" aria-live="polite" aria-atomic="true">${esc(state.pushNotice)}</p>${state.configError ? control('Tentar novamente', 'push-config', 'data-rn-focus="push-config"') : ''}</details>`;
  }
  function drawPanel(state) {
    if (!active(state) || !modal?.open) return;
    const focused = state.restoreFocus || (modal.contains(document.activeElement) ? document.activeElement?.dataset?.rnFocus : null), scroll = modal.querySelector('.rn-body')?.scrollTop ?? 0;
    const disclosure = modal.querySelector('#rn-settings'); if (disclosure) state.settingsOpen = disclosure.open;
    const rows = state.items.filter(item => !state.unreadOnly || !item.readAt);
    modal.innerHTML = `<div class="rn-heading"><div><h2 id="rn-title">Notificações</h2><p>Somente os avisos deste acesso.</p></div>${control('×', 'close', 'aria-label="Fechar notificações" data-rn-focus="close"')}</div><div class="rn-toolbar"><div class="rn-filters" aria-label="Filtrar notificações">${control('Todas', 'filter', `data-unread="false" aria-pressed="${!state.unreadOnly}" data-rn-focus="all"`)}${control('Não lidas', 'filter', `data-unread="true" aria-pressed="${state.unreadOnly}" data-rn-focus="unread"`)}</div>${control('Marcar todas como lidas', 'read-all', `${!state.unreadCount || state.mutating ? 'disabled' : ''} data-rn-focus="read-all"`)}</div><div class="rn-body">${state.error ? `<div class="rn-error" role="alert">${esc(state.error)}${control('Tentar novamente', 'refresh', 'data-rn-focus="retry"')}</div>` : ''}${state.loading && !rows.length ? '<p class="rn-empty" role="status">Carregando avisos…</p>' : rows.length ? `<ol class="rn-list">${rows.map(item => `<li class="rn-item${item.readAt ? '' : ' rn-new'}"><button type="button" class="rn-item-main" data-rn-action="open" data-id="${esc(item.id)}" data-rn-focus="item-${esc(item.id)}"><strong>${esc(item.title)}</strong><span>${esc(item.body)}</span><time>${esc(date(item.createdAt))}</time></button>${item.readAt ? '' : control('Marcar como lida', 'read', `data-id="${esc(item.id)}" ${state.mutating ? 'disabled' : ''} aria-label="Marcar como lida: ${esc(item.title)}" data-rn-focus="read-${esc(item.id)}"`)}</li>`).join('')}</ol>` : `<p class="rn-empty">${state.unreadOnly ? 'Nenhuma notificação não lida.' : 'Você ainda não tem notificações.'}</p>`}${state.nextBefore ? control(state.loading ? 'Carregando…' : 'Carregar mais', 'more', state.loading ? 'disabled' : '') : ''}${settings(state)}</div>`;
    modal.querySelector('.rn-body').scrollTop = scroll;
    if (focused) {
      const controls = [...modal.querySelectorAll('[data-rn-focus]')], preferred = focused.startsWith('read-') && focused !== 'read-all' ? 'item-' + focused.slice(5) : focused.startsWith('push-') ? 'push-settings' : '';
      const target = controls.find(node => node.dataset.rnFocus === focused && !node.disabled) ?? controls.find(node => node.dataset.rnFocus === preferred && !node.disabled) ?? controls.find(node => node.dataset.rnFocus === (state.unreadOnly ? 'unread' : 'all')) ?? controls.find(node => node.dataset.rnFocus === 'close');
      target?.focus({ preventScroll: true });
      if (!state.mutating) state.restoreFocus = null;
    }
  }
  async function feed(state, append = false) {
    if (!active(state) || state.stopped || !visible()) return;
    if (state.feedQueued) { state.refreshAfterFeed ||= !append; return; }
    state.feedQueued = true; const version = state.feedVersion, unreadOnly = state.unreadOnly, cursor = state.nextBefore;
    return queue(state, async () => {
      state.loading = true; state.error = ''; drawPanel(state);
      try {
        const query = new URLSearchParams({ limit: '20', ...(unreadOnly ? { unread: '1' } : {}), ...(append && cursor ? { before: cursor } : {}) });
        const result = await api(state, 'notifications?' + query), items = Array.isArray(result.items) ? result.items : [];
        if (!active(state) || version !== state.feedVersion) return;
        const retain = !append && state.loadedMore && modal?.open, refreshedIds = new Set(items.map(item => item.id));
        const merged = append ? [...state.items, ...items] : retain ? [...items, ...state.items.filter(item => !refreshedIds.has(item.id))] : items;
        if (append) state.loadedMore = true;
        state.items = [...new Map(merged.filter(item => item && typeof item.id === 'string').map(item => [item.id, item])).values()];
        state.unreadCount = Math.max(0, Number(result.unreadCount) || 0); if (!retain) state.nextBefore = typeof result.nextBefore === 'string' ? result.nextBefore : null; state.failures = 0; state.lastFetch = Date.now();
      } catch (error) { if (active(state) && !error.session) { state.failures++; state.error = error.message; } }
      finally { state.loading = false; state.feedQueued = false; drawBell(state); drawPanel(state); if (state.refreshAfterFeed && active(state) && !state.stopped) { state.refreshAfterFeed = false; feed(state); } else schedule(state); }
    });
  }
  async function ensureSession(state) {
    if (state.csrf && state.user?.id) return;
    const session = await api(state, 'session'); if (!active(state)) return; const actual = session.customer ?? session.user; if (!actual || !session.csrf || state.user?.id && actual.id !== state.user.id || !state.user?.id && state.user?.name && actual.name !== state.user.name || state.operation && session.operationsAvailable !== true) { expire(state); throw Error('Entre novamente para continuar.'); } state.user = actual; state.csrf = session.csrf; remembered = { slug: state.slug, audience: state.audience, user: actual, csrf: state.csrf, operation: state.operation };
  }
  async function config(state) {
    await ensureSession(state);
    if (state.config) return state.config;
    const result = await api(state, 'notifications/config'); if (active(state)) { state.config = result; if (state.configError) state.pushNotice = ''; state.configError = false; }
    return result;
  }
  async function openPanel(state) {
    if (!active(state) || state.stopped) return;
    if (!modal) { modal = document.createElement('dialog'); modal.id = 'rael-notifications-panel'; modal.className = 'rn-panel'; modal.setAttribute('aria-labelledby', 'rn-title'); document.body.append(modal); modal.addEventListener('cancel', event => { event.preventDefault(); closePanel(); }); modal.addEventListener('close', () => { if (current) drawBell(current); }); }
    if (!modal.open) modal.showModal(); drawPanel(state); drawBell(state); modal.querySelector('[data-rn-action="close"]')?.focus();
    queue(state, async () => { try { await config(state); } catch (error) { if (!error.session) { state.pushNotice = error.message; state.configError = true; } } drawPanel(state); });
  }
  async function read(state, item) {
    if (item?.readAt) return;
    await ensureSession(state);
    const result = await api(state, 'notifications/read', item ? { id: item.id } : { all: true });
    if (!active(state)) return;
    const changed = item ? state.items.filter(row => row.id === item.id && !row.readAt).length : state.unreadCount;
    for (const row of state.items) if (!item || row.id === item.id) row.readAt ||= Date.now();
    state.unreadCount = Number.isFinite(Number(result.unreadCount)) ? Math.max(0, Number(result.unreadCount)) : Math.max(0, state.unreadCount - changed);
  }
  const decodeKey = value => { const base64 = String(value).replace(/-/g, '+').replace(/_/g, '/'), raw = atob(base64 + '='.repeat((4 - base64.length % 4) % 4)); return Uint8Array.from(raw, c => c.charCodeAt(0)); };
  function currentPush(state, attempt) { return active(state) && !state.stopped && state.pushAttempt === attempt && !attempt.cancelled && state.csrf === attempt.csrf; }
  function cancelPush(state) {
    const attempt = state.pushAttempt; if (!attempt) return;
    attempt.cancelled = true; attempt.controller?.abort();
    for (const cancel of [...attempt.cancelers]) cancel();
    state.pushAttempt = null;
  }
  function pushStep(state, attempt, operation, { notice, timeout = 15000, failure, preserveError = false } = {}) {
    if (!currentPush(state, attempt)) return Promise.reject(Object.assign(Error('Acesso encerrado.'), { session: true }));
    state.pushNotice = notice; drawPanel(state);
    return new Promise((resolve, reject) => {
      let finished = false, timer;
      function finish(error, value) {
        if (finished) return; finished = true;
        if (timer) clearTimeout(timer); attempt.cancelers.delete(cancel);
        if (error) reject(error); else resolve(value);
      }
      const cancel = () => finish(Object.assign(Error('Acesso encerrado.'), { session: true }));
      attempt.cancelers.add(cancel);
      if (timeout) timer = setTimeout(() => {
        attempt.cancelled = true; attempt.controller?.abort();
        finish(Error(failure + ' A tentativa foi interrompida; toque em Tentar ativar novamente.'));
      }, timeout);
      Promise.resolve().then(() => {
        if (!currentPush(state, attempt)) throw Object.assign(Error('Acesso encerrado.'), { session: true });
        return operation();
      }).then(value => {
        if (!currentPush(state, attempt)) cancel(); else finish(null, value);
      }, error => finish(error?.session || preserveError ? error : Error(failure + ' Confira sua conexão e tente novamente.')));
    });
  }
  async function activatePush(state) {
    const support = browserSupport(); if (!support.available) { state.pushNotice = support.help; return; }
    const cfg = state.config; if (!cfg?.pushAvailable || !cfg.publicKey) { state.pushNotice = 'Aguarde a conferência deste navegador e tente novamente.'; return; }
    const attempt = { csrf: state.csrf, cancelled: false, cancelers: new Set(), controller: typeof AbortController === 'function' ? new AbortController() : null };
    state.pushAttempt = attempt; state.pushFailed = false;
    try {
      const permission = await pushStep(state, attempt, () => state.permissionRequest, { notice: window.Notification.permission === 'granted' ? 'Permissão concedida. Preparando os avisos deste navegador…' : 'Aguardando sua escolha na permissão do navegador. Selecione Permitir para continuar.', timeout: 0, failure: 'Não foi possível conferir a permissão do navegador.' });
      state.permissionRequest = null;
      if (permission !== 'granted') { state.pushNotice = permission === 'denied' ? 'A permissão foi bloqueada. Você pode mudar essa escolha nas configurações do navegador.' : 'A permissão não foi concedida. Você pode ativar os avisos depois.'; return; }
      await pushStep(state, attempt, () => navigator.serviceWorker.register('/notifications-sw.js', { scope: '/' }), { notice: 'Permissão concedida. Preparando os avisos deste navegador…', failure: 'Não foi possível preparar os avisos deste navegador.' });
      const registration = await pushStep(state, attempt, () => navigator.serviceWorker.ready, { notice: 'Concluindo a preparação dos avisos deste navegador…', timeout: 12000, failure: 'A preparação dos avisos neste navegador demorou.' });
      if (!registration?.scope || new URL(registration.scope, location.origin).href !== new URL('/', location.origin).href || !registration.active || new URL(registration.active.scriptURL, location.origin).pathname !== '/notifications-sw.js') throw Error('Recarregue a página para concluir a preparação dos avisos neste navegador.');
      const existing = await pushStep(state, attempt, () => registration.pushManager.getSubscription(), { notice: 'Conferindo a conexão dos avisos neste navegador…', timeout: 12000, failure: 'Não foi possível conferir a conexão dos avisos.' });
      const subscription = existing ?? await pushStep(state, attempt, () => registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: decodeKey(cfg.publicKey) }), { notice: 'Conectando ao serviço de avisos do navegador. Isso pode levar alguns segundos…', timeout: 20000, failure: 'A conexão ao serviço de avisos do navegador demorou.' });
      await pushStep(state, attempt, () => api(state, 'notifications/push', { subscription: subscription.toJSON() }, attempt.controller?.signal), { notice: 'Salvando a ativação dos avisos para este acesso…', timeout: 15000, failure: 'Não foi possível confirmar a ativação dos avisos.', preserveError: true });
      if (!currentPush(state, attempt)) return;
      state.config.pushEnabled = true; state.pushNotice = 'Avisos ativados neste navegador para este acesso.';
    } finally {
      if (state.pushAttempt === attempt) state.pushAttempt = null;
      state.permissionRequest = null;
    }
  }
  async function disablePush(state) {
    const registration = await navigator.serviceWorker?.getRegistration('/'), subscription = await registration?.pushManager?.getSubscription();
    if (subscription) await api(state, 'notifications/push-remove', { endpoint: subscription.endpoint });
    if (state.config) state.config.pushEnabled = false;
    state.pushNotice = subscription ? 'Avisos desativados neste navegador para este acesso.' : 'Não há avisos ativos para este navegador.';
  }
  async function action(state, target) {
    const name = target.dataset.rnAction;
    if (name === 'close') { closePanel(); return; }
    if (name === 'filter') { const unread = target.dataset.unread === 'true'; if (unread !== state.unreadOnly) { state.unreadOnly = unread; state.feedVersion++; state.loadedMore = false; state.nextBefore = null; state.items = []; await feed(state); } return; }
    if (name === 'refresh') { state.failures = 0; await feed(state); return; }
    if (name === 'more') { if (state.nextBefore) await feed(state, true); return; }
    if (state.mutating) return;
    state.mutating = true; state.restoreFocus = target.dataset.rnFocus ?? null; target.disabled = true; if (name.startsWith('push-')) drawPanel(state);
    await queue(state, async () => {
      try {
        const item = state.items.find(row => row.id === target.dataset.id);
        if (name === 'read' || name === 'open') { if (!item) return; await read(state, item); if (!active(state) || state.stopped) return; if (name === 'open') { const url = safeUrl(item.url, state); if (url) { closePanel(false); location.assign(url); } } }
        if (name === 'read-all') await read(state);
        if (name === 'push-config') { state.config = null; await config(state); }
        if (name === 'push-enable') await activatePush(state);
        if (name === 'push-disable') await disablePush(state);
        if (name === 'push-test') { await api(state, 'notifications/test', {}); state.pushNotice = 'Teste solicitado. Confira a central e os avisos deste dispositivo.'; }
      } catch (error) { if (active(state) && !error.session) { if (name.startsWith('push-')) { state.pushNotice = error.message; if (name === 'push-enable') state.pushFailed = true; } else state.error = error.message; } }
      finally { state.mutating = false; drawBell(state); drawPanel(state); schedule(state); }
    });
    if (name === 'push-test') await feed(state);
  }
  function configureManifest(slug) {
    const link = document.getElementById?.('rael-app-manifest'), area = location.pathname.split('/').filter(Boolean)[0];
    if (link && slug && ['sistema', 'negocio', 'planos'].includes(area)) link.href = `/manifest/${area}/${encodeURIComponent(slug)}.webmanifest`;
  }
  function mount({ slug, audience = 'staff', user, csrf = '', operation = false } = {}) {
    configureManifest(slug);
    if (!slug || !user) { unmount(); return; }
    const identity = `${slug}:${audience}:${user.id ?? user.email ?? user.name ?? ''}`;
    if (current?.identity === identity && !(current.stopped && csrf && csrf !== current.csrf)) { if (csrf && csrf !== current.csrf) { cancelPush(current); current.csrf = csrf; current.config = null; current.configError = true; current.pushNotice = 'Seu acesso mudou. Toque em Tentar novamente para conferir este navegador antes de ativar.'; } drawBell(current); drawPanel(current); return; }
    unmount();
    const state = { identity, slug, audience: audience === 'customer' ? 'customer' : 'staff', user, csrf, operation, active: true, stopped: false, items: [], unreadCount: 0, nextBefore: null, unreadOnly: false, loading: false, feedQueued: false, feedVersion: 0, refreshAfterFeed: false, loadedMore: false, mutating: false, failures: 0, lastFetch: 0, error: '', pushNotice: '', pushFailed: false, pushAttempt: null, settingsOpen: false, configError: false, timer: null, queue: Promise.resolve(), controller: typeof AbortController === 'function' ? new AbortController() : null, generation: ++generation };
    current = state; remembered = { slug, audience, user, csrf, operation }; drawBell(state);
    if (csrf && user.id) feed(state);
    else queue(state, async () => { try { await ensureSession(state); } catch (error) { if (active(state) && !error.session) { state.error = error.message; state.failures = 3; } } }).then(() => { if (active(state) && state.csrf) feed(state); });
  }
  document.addEventListener('click', event => {
    const state = current; if (!state || state.stopped) return;
    if (event.target.closest?.('[data-rn-bell]')) { openPanel(state); return; }
    const target = event.target.closest?.('[data-rn-action]');
    if (target && !target.disabled && modal?.contains(target)) {
      if (target.dataset.rnAction === 'push-enable') {
        const support = browserSupport();
        if (!support.available || !state.config?.pushAvailable || !state.config.publicKey) { state.pushNotice = !support.available ? support.help : 'Aguarde a conferência deste navegador e tente novamente.'; drawPanel(state); return; }
        if (state.mutating) return;
        state.pushNotice = window.Notification.permission === 'granted' ? 'Permissão concedida. Preparando os avisos deste navegador…' : 'Aguardando sua escolha na permissão do navegador. Selecione Permitir para continuar.'; state.pushFailed = false;
        try { state.permissionRequest = Promise.resolve(window.Notification.permission === 'granted' ? 'granted' : window.Notification.requestPermission()); state.permissionRequest.catch(() => {}); }
        catch { state.pushNotice = 'Não foi possível pedir a permissão. Confira as configurações deste navegador.'; drawPanel(state); return; }
      }
      action(state, target);
    }
  });
  document.addEventListener('visibilitychange', () => { const state = current; if (!state) return; if (!visible()) stopTimer(state); else if (!state.stopped && state.csrf) { if (Date.now() - state.lastFetch >= 30000) feed(state); else schedule(state); } });
  window.addEventListener('pagehide', () => { const context = remembered; unmount(); remembered = context; });
  window.addEventListener('pageshow', event => { if (event.persisted && remembered) { const context = remembered; mount({ ...context, csrf: '' }); } });
  window.RaelNotifications = { mount, unmount, safeUrl, configureManifest, beforeLogout: unmount };
})();
