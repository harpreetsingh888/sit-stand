/**
 * Keeping the app usable when the phone has no signal.
 *
 * The shell is cached so it opens instantly and never shows a blank page.
 * Reads of the current state and the day are cached too, so opening it
 * offline shows the last thing it knew rather than an error. Writes are never
 * cached: the page queues those itself and replays them when it reconnects,
 * because a write replayed by a service worker has no way to tell you it
 * disagreed with what the desktop recorded.
 */

const VERSION = 'desk-log-v2';
const SHELL = [
  '/',
  '/app.css',
  '/app.js',
  '/timeline.js',
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
];

/** Reads worth keeping a copy of, so the app opens with something to show. */
const CACHEABLE_READS = ['/api/state', '/api/day', '/api/history'];

/**
 * Everything is fetched from the network first, with the cache as the fallback
 * for when there is none.
 *
 * Serving the shell from cache first was a mistake: the page and the scripts
 * have to agree with each other, and a cached page paired with newer scripts
 * looks for elements that are not there. Over a connection to a machine on
 * your own network the network-first round trip costs nothing worth saving,
 * and it means an updated app is picked up the moment it is published.
 */

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => n !== VERSION).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return; // writes always go to the network

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(networkFirst(request));
});

/** Fresh data when we can get it, the last copy when we cannot. */
async function networkFirst(request) {
  const url = new URL(request.url);
  // Look only in this version's cache. `caches.match` without a name searches
  // every cache the origin has ever held, so a leftover from an older version
  // could still be served long after it stopped being correct.
  const cache = await caches.open(VERSION);

  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) return cached;

    // A page asked for with no connection and nothing saved: give back the
    // shell if we have it, so the app opens instead of showing a browser error.
    if (request.mode === 'navigate') {
      const shell = await cache.match('/');
      if (shell) return shell;
    }
    if (CACHEABLE_READS.some((path) => url.pathname === path)) {
      return new Response(
        JSON.stringify({ ok: false, data: null, error: { message: 'Offline, and nothing saved yet.' } }),
        { status: 503, headers: { 'content-type': 'application/json' } },
      );
    }
    throw error;
  }
}

