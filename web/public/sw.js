const CACHE_NAME = "setu-shell-v2";
const APP_SHELL = ["/", "/logo.png", "/favicon.png", "/apple-touch-icon.png", "/bg-waves.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()),
  );
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

  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request).then(cachePut)),
  );
});
