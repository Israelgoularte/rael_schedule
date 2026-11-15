'use strict';

// This worker delivers optional browser notices. It never caches pages, sessions
// or responses; access to each destination is still checked by the application.
const safeDestination = value => {
  try {
    const url = new URL(value, self.location.origin);
    if (url.origin !== self.location.origin || url.username || url.password || url.hash || !/^\/(?:sistema\/[a-z0-9][a-z0-9-]{1,47}(?:\/(?:assinatura|assinaturas|painel))?|negocio\/[a-z0-9][a-z0-9-]{1,47}|planos\/[a-z0-9][a-z0-9-]{1,47})$/.test(url.pathname)) return self.location.origin + '/sistema';
    // Only navigation state is carried into a destination, never arbitrary URL
    // parameters, credentials, attribution or text supplied by a push message.
    const clean = new URL(url.pathname, self.location.origin);
    if (url.pathname.startsWith('/sistema/') && ['agenda', 'perfil'].includes(url.searchParams.get('visao'))) clean.searchParams.set('visao', url.searchParams.get('visao'));
    if (clean.searchParams.get('visao') === 'agenda' && /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('data') || '')) clean.searchParams.set('data', url.searchParams.get('data'));
    if (url.pathname.startsWith('/negocio/') && url.searchParams.get('visao') === 'agendamentos') clean.searchParams.set('visao', 'agendamentos');
    return clean.href;
  } catch { return self.location.origin + '/sistema'; }
};

self.addEventListener('install', event => { event.waitUntil(self.skipWaiting()); });
self.addEventListener('activate', event => { event.waitUntil(self.clients.claim()); });
self.addEventListener('push', event => {
  let payload = {};
  try { payload = event.data?.json() || {}; } catch { /* Show a generic notice even for an empty push. */ }
  const id = typeof payload.id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(payload.id) ? payload.id : 'update';
  event.waitUntil(self.registration.showNotification('Rael Agendamentos', {
    body: 'Você tem uma nova notificação. Abra o sistema para conferir.',
    tag: 'rael-' + id,
    icon: '/app-icon-v4-192.png',
    badge: '/notification-badge.png',
    data: { url: safeDestination(payload.url) },
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const destination = safeDestination(event.notification.data?.url);
  event.waitUntil((async () => {
    const url = new URL(destination), windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const window of windows) {
      try {
        const open = new URL(window.url);
        if (open.origin !== url.origin || open.pathname !== url.pathname) continue;
        const navigated = await window.navigate(destination);
        if (navigated) return navigated.focus();
      } catch { /* A closed or inaccessible tab does not prevent opening the notice. */ }
    }
    return self.clients.openWindow(destination);
  })());
});
