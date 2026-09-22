/**
 * public/sw.js — PGA-DAMIS Service Worker
 *
 * Strategy:
 *  - Static assets (CSS, fonts, manifest): Stale-while-revalidate — serves the
 *    cached copy instantly, then re-fetches in the background and overwrites
 *    the cache, so a CSS deploy reaches the browser on the very next load
 *    without needing a manual CACHE_VERSION bump.
 *  - JS files: Network-first (always fresh — avoids stale code bugs)
 *  - HTML pages: not intercepted — pass through natively
 *  - API calls: Network-only (always fresh)
 *
 * IMPORTANT: Bump CACHE_VERSION any time you change STATIC_ASSETS itself
 * (add/remove a precached file) or need to force a one-time hard reset of
 * every client's cache. Routine CSS/asset content changes no longer need a
 * bump — stale-while-revalidate picks them up automatically.
 */

const CACHE_VERSION = 'pgadamis-v2';
const STATIC_ASSETS = [
  '/css/app.css',
  '/css/auth.css',
  '/css/polish.css',
  '/manifest.json',
  // NOTE: JS files intentionally excluded — they use network-first so
  // updates are always picked up without requiring a cache version bump.
];

// ── Install: cache static assets ─────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// ── Activate: clean up ALL old caches ─────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => {
        console.log('[SW] Deleting old cache:', k);
        return caches.delete(k);
      }))
    )
  );
  self.clients.claim();
});

// ── Fetch: routing strategy ───────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET and API/socket requests — pass through untouched
  if (request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/')) return;
  if (url.pathname.startsWith('/auth/')) return; // OAuth redirects — never intercept
  if (url.origin !== location.origin) return; // CDN resources — skip

  // HTML pages / navigation: do NOT intercept — let browser handle redirects
  // and auth flows (Google OAuth, pending approval redirects) natively.
  // Intercepting navigation causes "Offline" flashes when fetch() fails or
  // when the server returns a redirect that the SW can't forward correctly.
  if (request.mode === 'navigate' || request.headers.get('accept')?.includes('text/html')) {
    return; // pass-through entirely
  }

  // JS files: network-first (always fresh — never serve stale JS)
  if (url.pathname.endsWith('.js')) {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(request, clone));
          }
          return res;
        })
        .catch(() =>
          caches.match(request)
            .then((r) => r || new Response('// offline', { status: 503 }))
        )
    );
    return;
  }

  // CSS/fonts/images: stale-while-revalidate — serve the cached copy
  // instantly (same speed as cache-first), but always re-fetch in the
  // background and overwrite the cache so the NEXT load already has the
  // latest deploy. This is what actually fixes the "CSS fix isn't showing
  // up" class of bug: cache-first never asks the network again once a URL
  // is cached, so a deploy could ship correctly and still never be seen.
  event.respondWith(
    caches.match(request).then((cached) => {
      const fetchAndUpdate = fetch(request).then((res) => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(request, clone));
        }
        return res;
      }).catch(() => cached);

      return cached || fetchAndUpdate;
    })
  );
});
