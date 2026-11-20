const CACHE = 'timeline-v1';
const ASSETS = ['./', 'index.html', 'app.js', 'parser.js', 'manifest.json', 'lib/leaflet.js', 'lib/leaflet.css'];
self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS))));
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
});
