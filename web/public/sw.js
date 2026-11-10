/* No fetch/offline cache: authentication and admin permissions always come from the server. */
self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data?.json() || {}; } catch { /* Show a safe fallback. */ }
  let destination = '/admin/dashboard';
  try {
    const url = new URL(payload.url, self.location.origin);
    if (url.origin === self.location.origin && ['/admin/dashboard','/admin/history'].includes(url.pathname)) destination = url.pathname + url.search;
  } catch { /* Never open a supplied external URL. */ }
  event.waitUntil(self.registration.showNotification(payload.title || 'SPATE Charge', {
    body: payload.body || 'Há uma atualização no carregador.', icon: '/apple-touch-icon.png',
    tag: payload.tag || 'spate-charge', data: { url: destination },
  }));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const url = new URL(event.notification.data?.url || '/admin/dashboard', self.location.origin);
    if (url.origin !== self.location.origin || !['/admin/dashboard','/admin/history'].includes(url.pathname)) return;
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find((client) => new URL(client.url).origin === self.location.origin);
    if (existing) { await existing.navigate(url.href); await existing.focus(); }
    else await self.clients.openWindow(url.href);
  })());
});
