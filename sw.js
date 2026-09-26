// TNT Roadside service worker
// Deliberately simple for MVP: caches the core shell for installability
// and offline fallback, but always prefers a fresh copy of the page over
// the cache when the network is available -- this app changes often
// right now, and a customer stuck on a stale cached version mid-build
// would be worse than no caching at all.

const CACHE_NAME = 'tnt-roadside-v6';
const CORE_ASSETS = [
  '/',
  '/hub.html',
  '/hub-manifest.json',
  '/index.html',
  '/manifest.json',
  '/tech.html',
  '/tech-manifest.json',
  '/admin.html',
  '/admin-manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-192-maskable.png',
  '/icons/icon-512-maskable.png',
  '/icons/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Network-first for page navigations, so a build pushed to Vercel
  // shows up immediately instead of serving yesterday's cached HTML.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() =>
        caches.match(request).then((cached) => cached || caches.match('/index.html'))
      )
    );
    return;
  }

  // Cache-first for everything else (icons, manifest) -- these rarely
  // change, and it means the installed app shell still loads offline.
  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request))
  );
});
