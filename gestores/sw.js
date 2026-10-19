/* ==========================================================================
   Service Worker de la app del PERSONAL DE LA EMPRESA (aparte del Portal del Conductor)

   Su alcance es solo esta carpeta (gestores/), así que no se mete con el del
   portal. Guarda la app para que "Leer código del bus" funcione sin internet
   (el registro queda en el celular y se manda cuando vuelve la señal).
     - Páginas ........................... red primero, cae a la guardada
     - Archivos de la app (aquí y del portal) cache primero, con su ?v= exacto (sin señal, el guardado)
     - Supabase .......................... siempre a la red, nunca se guarda
   Solo borra sus propias cachés (las que empiezan por "gestores-"): las del
   portal son del service worker del portal.
   ========================================================================== */

// Igual a VERSION de gestores-app.js y a los ?v= de index.html. Que este
// archivo cambie es lo que avisa a los teléfonos de que hay una versión nueva.
const VERSION = "g2.3.3";
const CACHE = "gestores-" + VERSION;

const ARCHIVOS = [
  "./",
  "./index.html",
  "./gestores.css",
  "./gestores-app.js",
  "./manifest.webmanifest",
  "./assets/icon-192.png",
  "./assets/icon-512.png",
  "./assets/icon-maskable-512.png",
  "./assets/apple-touch-icon.png",
  "../css/portal.css",
  "../js/portal-config.js",
  "../js/vendor/jsQR.min.js",
  "../assets/logo-combuses.webp",
];

const HOSTS_SIN_CACHE = ["supabase.co", "supabase.in"];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(ARCHIVOS.map((url) => cache.add(new Request(url, { cache: "reload" })).catch(() => null)));
    // La app no tiene nada a medias que se pueda perder: la versión nueva entra de una.
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const claves = await caches.keys();
    await Promise.all(claves.filter((k) => k.startsWith("gestores-") && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  let url;
  try { url = new URL(req.url); } catch (_) { return; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return;
  if (HOSTS_SIN_CACHE.some((h) => url.hostname.endsWith(h))) return;

  if (req.mode === "navigate") {
    event.respondWith(pagina(req));
    return;
  }
  event.respondWith(cachePrimero(req));
});

async function pagina(req) {
  try {
    const res = await fetch(req.url, { cache: "no-cache", credentials: "same-origin" });
    if (res.redirected) return Response.redirect(res.url, 302);
    if (res && res.ok) (await caches.open(CACHE)).put("./index.html", res.clone());
    return res;
  } catch (_) {
    const cache = await caches.open(CACHE);
    return (await cache.match("./index.html")) || (await cache.match("./")) ||
      new Response("Sin conexión", { status: 503, statusText: "Sin conexión" });
  }
}

// Con el ?v= exacto primero: así una página nueva nunca recibe el programa de otra versión.
// Sin señal sí cae a la guardada aunque el ?v= no coincida (para leer el bus sin internet).
async function cachePrimero(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res && (res.ok || res.type === "opaque")) cache.put(req, res.clone());
    return res;
  } catch (_) {
    return (await cache.match(req, { ignoreSearch: true })) ||
      new Response("Sin conexión", { status: 503, statusText: "Sin conexión" });
  }
}
