const CACHE_NAME = 'medtracker-v29';
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
      .then(() => {
        // First install: activate immediately. Updates go through the banner flow.
        if (!self.registration.active) self.skipWaiting();
      })
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
//   HTML + JS (critical app code) → network-first (always serve matched versions)
//   Other static assets → stale-while-revalidate (icons, manifest)
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Only handle same-origin requests
  if (url.origin !== self.location.origin) return;

  // HTML / navigation + JS modules: network-first to prevent version mismatch
  const isNavigation = event.request.mode === 'navigate' || url.pathname === '/' || url.pathname === '/index.html';
  const isAppJs = url.pathname.endsWith('.js') && url.pathname.startsWith('/app/');
  if (isNavigation || isAppJs) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(event.request, {ignoreSearch: true}).then(cached => cached || caches.match('/', {ignoreSearch: true})))
    );
    return;
  }

  // Other static assets (icons, manifest): stale-while-revalidate
  event.respondWith(
    caches.match(event.request).then(cached => {
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

      return cached || fetchPromise;
    })
  );
});
