const APP_VERSION = "20260906a-fix-duplicate-dni-colaborador";
const CACHE_NAME = `combuses-asistencia-${APP_VERSION}`;
const APP_SHELL = [
  "./asistencia-web.html",
  "./asistencia.css",
  "./asistencia.js",
  "./supabase-config.js",
  "./manifest.json",
  "./assets/logo-combuses.webp",
  "./assets/icon-192.png",
  "./assets/icon-512.png",
  "./assets/icon-maskable-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(
      APP_SHELL.map((url) => cache.add(new Request(url, { cache: "reload" })).catch(() => null))
    );
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((key) =>
          (key.startsWith("combuses-asistencia-") || key.startsWith("combuses-static-"))
          && key !== CACHE_NAME)
        .map((key) => caches.delete(key))
    );
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.endsWith("/sw.js")) return;

  const esDocumento =
    request.mode === "navigate" || request.destination === "document";

  if (esDocumento) {
    event.respondWith(networkFirst(request));
    return;
  }

  const esEstatico = ["script", "style", "image", "font", "manifest"].includes(
    request.destination
  );

  if (esEstatico) {
    event.respondWith(staleWhileRevalidate(request));
  }
});

async function networkFirst(request) {
  try {
    const fresca = await fetch(request);
    if (fresca && fresca.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, fresca.clone());
    }
    return fresca;
  } catch (_) {
    const cached = await caches.match(request);
    if (cached) return cached;
    return caches.match("./asistencia-web.html");
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  const fetchPromise = fetch(request)
    .then((respuesta) => {
      if (respuesta && respuesta.ok) {
        cache.put(request, respuesta.clone());
      }
      return respuesta;
    })
    .catch(() => cached);
  return cached || fetchPromise;
}
