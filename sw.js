const CACHE = 'timeline-v28';
const ASSETS = ['./', 'index.html', 'app.js', 'parser.js', 'clean.js', 'osm.js', 'tune.js', 'tune-worker.js', 'analyze.js', 'manifest.json', 'lib/leaflet.js', 'lib/leaflet.css', 'icons/icon-192.png', 'icons/icon-512.png'];
// 'reload' bypasses the browser's HTTP cache (GitHub Pages sends max-age=600), so an install never stores stale files.
self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(ASSETS.map((u) => fetch(new Request(u, { cache: 'reload' })).then((r) => (r.ok ? c.put(u, r) : null))))));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('timeline-v') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// Network first, always revalidating our own files (a stale page mixed with newer scripts breaks the app);
// the cache is only the offline fallback. Map tiles (other origin) keep their normal caching.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const same = new URL(e.request.url).origin === location.origin;
  e.respondWith(
    (same ? fetch(e.request.url, { cache: 'no-cache' }) : fetch(e.request)).then((res) => {
      if (res.ok && same) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request))
  );
});
