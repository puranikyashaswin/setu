/** Setu PWA service worker — shell cache only. Never pin voice-critical assets. */
const CACHE_NAME = "setu-shell-v4";
const APP_SHELL = ["/", "/logo.png", "/favicon.png", "/apple-touch-icon.png", "/bg-waves.png"];

/** Paths that must always hit the network (AudioWorklet / SW / hashed Next assets). */
function mustBypassCache(pathname) {
  if (pathname === "/sw.js") return true;
  if (pathname === "/vad-processor.js" || pathname.startsWith("/vad-processor.js")) return true;
  if (pathname.startsWith("/_next/")) return true;
  return false;
}

self.addEventListener("install", (event) => {
  // Do not skipWaiting here — let the app show "Update Setu" then activate.
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => key.startsWith("setu-") && key !== CACHE_NAME)
        .map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // Never cache API, audio, scan, or chat requests: they can contain private data.
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) {
    return;
  }

  // iPhone Safari + AudioWorklet: a cache-first SW is the #1 reason voice dies
  // after a Vercel deploy (stale /vad-processor.js). Always network these.
  if (mustBypassCache(url.pathname)) {
    event.respondWith(
      fetch(request, { cache: "no-store" }).catch(() => caches.match(request)),
    );
    return;
  }

  const cachePut = (response) => {
    if (!response.ok || response.type === "opaque") return response;
    const copy = response.clone();
    void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
    return response;
  };

  // Navigations go to the network first so a new deploy is picked up immediately;
  // the cache is only a fallback for offline.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then(cachePut)
        .catch(() => caches.match(request).then((cached) => cached || caches.match("/"))),
    );
    return;
  }

  // Other same-origin GETs: network-first (was cache-first — pinned broken voice JS).
  event.respondWith(
    fetch(request)
      .then(cachePut)
      .catch(() => caches.match(request)),
  );
});
