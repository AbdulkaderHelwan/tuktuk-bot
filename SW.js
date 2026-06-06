const CACHE = 'wasselni-v1';
const FILES = ['/app', '/manifest.json', 'https://fonts.googleapis.com/css2?family=Rubik:wght@400;500;600;700;800;900&display=swap',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES).catch(() => {})).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(clients.claim());
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request)
      .then(r => r || fetch(e.request).then(resp => {
        if (!resp || resp.status !== 200) return resp;
        const cache = caches.open(CACHE);
        cache.then(c => c.put(e.request, resp.clone()));
        return resp;
      }))
      .catch(() => caches.match('/app'))
  );
});
