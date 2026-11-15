const CACHE = 'contrail-v32';
const SHELL = ['./', 'index.html', 'app.js', 'airports.js', 'airlines.js', 'icon.svg', 'manifest.webmanifest', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))); self.clients.claim(); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (u.origin === location.origin) {
    // network first for app files so updates land quickly, cache fallback offline
    e.respondWith(fetch(e.request, { cache: 'no-cache' }).then(r => { const c = r.clone(); caches.open(CACHE).then(x => x.put(e.request, c)); return r; }).catch(() => caches.match(e.request).then(r => r || caches.match('index.html'))));
  } else if (/unpkg\.com|gibs\.earthdata\.nasa\.gov|gstatic\.com|pics\.avs\.io|cdn\.jsdelivr\.net/.test(u.host)) {
    e.respondWith(caches.match(e.request).then(r => r || fetch(e.request).then(res => { const c = res.clone(); caches.open(CACHE).then(x => x.put(e.request, c)); return res; })));
  }
});
self.addEventListener('push', e => {
  let n = {}; try { n = e.data ? e.data.json() : {}; } catch (x) { n = { title: 'Contrail', body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(n.title || 'Contrail', { body: n.body || '', tag: n.tag || undefined, renotify: !!n.tag, icon: 'icon-192.png', badge: 'icon-192.png', data: { url: n.url || './' } }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope).href;
  const id = (url.match(/#open=([\w-]+)/) || [])[1];
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
    if (cs.length) { const c = cs[0]; if (id) c.postMessage({ open: id }); return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
