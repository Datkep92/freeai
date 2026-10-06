/**
 * Service worker: network-first, same-origin only.
 *
 * The app is a set of small static files that change often, so a stale cached
 * copy is worse than a slow one. Provider API calls are never touched: they
 * are cross-origin and must go straight to the network.
 */
// Bumped whenever the shell changes. A new worker with the old name would keep
// serving the previous cache, and the new name is what makes activate drop it.
const CACHE = 'fmh-v9';

/**
 * Everything the page needs to boot, listed explicitly.
 *
 * The app is ES modules: index.html pulls in app.js, which imports sixteen core
 * files. Caching only the two shell files - which is what this used to do -
 * meant an offline load served the HTML from cache and then failed on the first
 * module, leaving a blank page with no error to explain it. Listing the shell is
 * repetitive, and adding a core file to that list by hand would silently
 * reintroduce exactly that failure.
 *
 * `addAll` is all-or-nothing, so the manifest is deliberately not listed here;
 * one 404 would abort the whole install and there would be no cache at all.
 * Each entry is added on its own so a single missing file costs that file only.
 */
const SHELL = [
  './',
  './index.html',
  './app.js',
  './styles.css',
  './core/adapters/base.js',
  './core/adapters/builtin.js',
  './core/circuit.js',
  './core/config.js',
  './core/error-classifier.js',
  './core/free-detector.js',
  './core/health.js',
  './core/io.js',
  './core/key-registry.js',
  './core/key-requirement.js',
  './core/key-verifier.js',
  './core/mapper.js',
  './core/model-info.js',
  './core/metrics.js',
  './core/model-registry.js',
  './core/priority.js',
  './core/provider-registry.js',
  './core/router.js',
  './core/scanner.js',
  './core/statuses.js',
  './core/storage.js',
  './core/util.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      // Each add is independent so one bad entry cannot void the rest.
      Promise.all(SHELL.map((url) => cache.add(url).catch(() => {})))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // never cache provider APIs

  event.respondWith(
    fetch(request)
      .then((response) => {
        // Only a real response is worth storing. Caching an error or an opaque
        // reply would pin a failure in place and serve it on every later visit.
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
        }
        return response;
      })
      .catch(() =>
        caches
          .match(request)
          // A navigation that misses the cache falls back to the shell, so an
          // offline reload still opens the app rather than the browser's error
          // page. A missing module falls through as a miss, which surfaces as a
          // real error instead of being papered over with the wrong file.
          .then((hit) => hit ?? (request.mode === 'navigate' ? caches.match('./index.html') : null))
          .then((hit) => hit ?? Response.error())
      )
  );
});
