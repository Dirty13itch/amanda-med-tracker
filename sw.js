const CACHE_NAME = 'medtracker-v19';
const ASSETS = [
  '/',
  '/index.html',
  '/app/main.js',
  '/app/shared.js',
  '/app/storage.js',
  '/manifest.json',
  '/icon.svg',
  '/icon-192.png',
  '/icon-512.png'
];

// Install: pre-cache the app shell for offline use.
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(ASSETS))
  );
});

// Activate: clean up ALL old caches, claim clients immediately.
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Updates become active only after the page explicitly asks for it.
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// Fetch strategy:
//   HTML (navigation requests) → network-first (fresh app on every load when online)
//   Static assets → stale-while-revalidate (serve cached, update in background)
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Only handle same-origin requests
  if (url.origin !== self.location.origin) return;

  // HTML / navigation: network-first
  if (event.request.mode === 'navigate' || url.pathname === '/' || url.pathname === '/index.html') {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          // Cache the fresh HTML for offline use
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(event.request).then(cached => cached || caches.match('/')))
    );
    return;
  }

  // Static assets: stale-while-revalidate
  event.respondWith(
    caches.match(event.request).then(cached => {
      // Start a background fetch to update the cache
      const fetchPromise = fetch(event.request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => {
        if (cached) return cached;
        return new Response('Offline', { status: 503 });
      });

      // Return cached immediately if available, otherwise wait for network
      return cached || fetchPromise;
    })
  );
});
