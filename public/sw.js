// brx service worker — app-shell precache + runtime tile caching.
// The two placeholder tokens below are replaced at build time by the
// vite.config.js closeBundle plugin (a precache file list, and a content
// hash used as the build version). Left unreplaced — e.g. serving this
// file straight from source in dev — they degrade gracefully: the literal
// placeholder is filtered out of the precache list, and VERSION falls
// back to 'dev'.
const PRECACHE = ["__PRECACHE__"].filter((u) => u !== "__PRECACHE__");
const BUILD_VERSION = "__BUILD_VERSION__";
const VERSION = BUILD_VERSION === "__BUILD_VERSION__" ? "dev" : BUILD_VERSION;

const SHELL_CACHE = `brx-shell-${VERSION}`;
const TILE_CACHE = "tiles";
const TILE_CACHE_CAP = 2000;
const TILE_EVICT_BATCH = 100;

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // Tolerate individual failures so one missing/blocked asset doesn't
      // abort the whole install.
      await Promise.all(
        PRECACHE.map(async (url) => {
          try {
            await cache.add(url);
          } catch (err) {
            console.warn("[sw] precache failed for", url, err);
          }
        })
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k !== SHELL_CACHE && k !== TILE_CACHE)
          .map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

async function trimTileCache() {
  const cache = await caches.open(TILE_CACHE);
  const keys = await cache.keys();
  if (keys.length > TILE_CACHE_CAP) {
    const toEvict = keys.slice(0, TILE_EVICT_BATCH);
    await Promise.all(toEvict.map((req) => cache.delete(req)));
  }
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response && response.ok) {
    await cache.put(request, response.clone());
    if (cacheName === TILE_CACHE) await trimTileCache();
  }
  return response;
}

async function shellFetch(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response && response.ok) await cache.put(request, response.clone());
    return response;
  } catch (err) {
    if (request.mode === "navigate") {
      const fallback = await cache.match("/index.html");
      if (fallback) return fallback;
    }
    throw err;
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Non-GET requests are never cached.
  if (request.method !== "GET") return;

  // Overpass API: always network-only, never cached.
  if (url.hostname === "overpass-api.de") return;

  // OSM tiles: cache-first with LRU-ish cap, own cache bucket.
  if (url.hostname === "tile.openstreetmap.org") {
    event.respondWith(cacheFirst(request, TILE_CACHE));
    return;
  }

  // Same-origin navigations and precached assets: cache-first, network
  // fallback, with an index.html fallback for offline navigations.
  const isSameOrigin = url.origin === self.location.origin;
  const isNavigation = request.mode === "navigate";
  if (isSameOrigin && (isNavigation || PRECACHE.includes(url.pathname))) {
    event.respondWith(shellFetch(request));
  }
});
