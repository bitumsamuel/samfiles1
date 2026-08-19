const CACHE_NAME = 'selfless-ce-portal-v2';
const APP_SHELL = [
  './portal.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // Never cache API calls — always go to the network for live data.
  if (req.url.includes('/api/')) return;

  // Network-first: always try to get the latest page when online, and only
  // fall back to the cached copy if the network request fails (e.g. offline).
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.status === 200 && req.method === 'GET') {
          const resClone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, resClone));
        }
        return res;
      })
      .catch(() => caches.match(req))
  );
});
