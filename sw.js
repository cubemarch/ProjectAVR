const CACHE_PREFIX = 'projectavr-shell-';
const CACHE_NAME = `${CACHE_PREFIX}v3`;
const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './assets/icon.svg',
  './src/app.js',
  './src/catalog.js',
  './src/library-state.js',
  './src/media-utils.js',
  './src/stream-adapter.js',
  './src/vr-player.js'
];
const APP_SHELL_URLS = new Set(APP_SHELL.map((path) => new URL(path, self.location.href).href));

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const requestUrl = new URL(event.request.url);
  if (event.request.method !== 'GET' || requestUrl.origin !== self.location.origin) return;

  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(async () => {
        const cache = await caches.open(CACHE_NAME);
        return cache.match('./index.html');
      })
    );
    return;
  }

  const isShellRequest = APP_SHELL_URLS.has(requestUrl.href)
    && !event.request.headers.has('range')
    && !event.request.headers.has('authorization');
  if (!isShellRequest) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(event.request);
    if (cached) return cached;

    const response = await fetch(event.request);
    if (response.ok && response.type === 'basic') {
      await cache.put(event.request, response.clone());
    }
    return response;
  })());
});
