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

const VERSION = 'desk-log-v1';
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

  if (CACHEABLE_READS.some((path) => url.pathname === path)) {
    event.respondWith(networkFirst(request));
    return;
  }
  event.respondWith(cacheFirst(request));
});

/** Fresh data when we can get it, the last copy when we cannot. */
async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(VERSION);
      cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    const cached = await caches.match(request);
    if (cached) return cached;
    return new Response(
      JSON.stringify({ ok: false, data: null, error: { message: 'Offline, and nothing saved yet.' } }),
      { status: 503, headers: { 'content-type': 'application/json' } },
    );
  }
}

/** The shell changes rarely; serve it instantly and refresh in the background. */
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) {
    refreshInBackground(request);
    return cached;
  }
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(VERSION);
      cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    const shell = await caches.match('/');
    if (shell) return shell;
    throw error;
  }
}

function refreshInBackground(request) {
  fetch(request)
    .then(async (response) => {
      if (!response.ok) return;
      const cache = await caches.open(VERSION);
      cache.put(request, response);
    })
    .catch(() => {
      /* offline; the cached copy stands */
    });
}
