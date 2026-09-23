// Service worker: makes the app installable and lets the interface open
// without a connection. App files are network-first, so a new deploy shows up
// on the next load; the cache is only a fallback when offline or when the
// host returns a server error. Map and terrain
// tiles come from other origins and are left to the browser.

const CACHE = 'elevation-app-v2';
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
  const cached = () => caches.match(request, { ignoreSearch: true });
  event.respondWith(
    fetch(request)
      .then(async (response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
          return response;
        }
        // The host sometimes answers with a transient 5xx; a saved copy beats an error page.
        if (response.status >= 500) return (await cached()) || response;
        return response;
      })
      .catch(async () => (await cached()) || caches.match('./')),
  );
});
