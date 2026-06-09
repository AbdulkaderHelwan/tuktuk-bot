const CACHE = 'wasselni-v4';

self.addEventListener('install', e => { self.skipWaiting(); });
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE).map(k => caches.delete(k))
    )).then(() => clients.claim())
  );
});

// Network-first strategy
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || e.request.url.includes('/api/')) return;
  e.respondWith(
    fetch(e.request).then(resp => {
      if (resp && resp.status === 200) {
        caches.open(CACHE).then(c => c.put(e.request, resp.clone()));
      }
      return resp;
    }).catch(() => caches.match(e.request))
  );
});

// ---- PUSH NOTIFICATIONS ----
self.addEventListener('push', e => {
  if (!e.data) return;
  let data;
  try { data = e.data.json(); } catch { data = { title: 'Wasselni', body: e.data.text() }; }

  const options = {
    body: data.body || 'New ride request!',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: data.rideId || 'wasselni',
    requireInteraction: true,
    vibrate: [200, 100, 200, 100, 200],
    data: { rideId: data.rideId, url: self.registration.scope + 'app' },
    actions: [
      { action: 'accept', title: '✅ Accept' },
      { action: 'view', title: '👁 View' },
    ],
  };

  e.waitUntil(self.registration.showNotification(data.title || '🔔 Wasselni', options));
});

// When driver taps the notification
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || self.registration.scope + 'app';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url.includes('/app')) { client.focus(); return; }
      }
      return clients.openWindow(url);
    })
  );
});
