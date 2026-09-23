// Service worker: makes the app installable and lets the interface open
// without a connection. App files are network-first, so a new deploy shows up
// on the next load; the cache is only a fallback when offline. Map and terrain
// tiles come from other origins and are left to the browser.

const CACHE = 'elevation-app-v1';
const APP_FILES = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'dem.js',
  'terrain.js',
  'sun.js',
  'search.js',
  'pointinfo.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(APP_FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request, { ignoreSearch: true }).then((hit) => hit || caches.match('./'))),
  );
});
