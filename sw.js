/* ==========================================================================
   Service Worker único del Portal del Conductor - Combuses

   Registrado con scope "./" desde la raíz del portal, así que controla tanto
   el cascarón como los dos módulos embebidos. Los service workers propios de
   cada módulo quedaron desactivados a propósito (ver el bloque
   "PORTAL: service worker desactivado" en cada uno): dos SW compitiendo por
   el mismo scope se pisan las cachés y dejan versiones viejas pegadas.

   Estrategias por tipo de recurso:
     - Páginas (navegación) ............... network-first sin caché HTTP, cae al shell
     - App shell (HTML/CSS/JS/iconos) ..... cache-first + revalidación de fondo
     - Librerías de CDN y tipografías ..... cache-first (están versionadas)
     - Tiles del mapa (OpenStreetMap) ..... network-first, cae a caché
     - API Supabase (REST/Auth/Storage) ... network-only, nunca se cachea
     - Nómina en Google Sheets (CSV) ...... network-first, cae a caché

   Actualizaciones: una versión nueva se descarga completa y queda en espera.
   La activa el portal (js/portal.js, bloque "actualizaciones") cuando el
   conductor no está a mitad de algo.
   ========================================================================== */

// Igual a APP_VERSION de js/portal-config.js. No se cambia a mano: lo hace
// nueva-version.ps1 en todos los sitios a la vez. Que este archivo cambie es
// lo que avisa a los teléfonos de que hay una versión nueva.
const VERSION = "v1.6.2";
const CACHE_APP = "portal-app-" + VERSION;
const CACHE_CDN = "portal-cdn-" + VERSION;
const CACHE_TILES = "portal-tiles-" + VERSION;
const CACHE_DATOS = "portal-datos-" + VERSION;

// Máximo de tiles guardados. Sin tope, el mapa llena el almacenamiento del
// móvil tras unos días de uso.
const MAX_TILES = 300;

const APP_SHELL = [
  "./",
  "./index.html",
  "./css/portal.css",
  "./js/portal-config.js",
  "./js/portal.js",
  "./manifest.webmanifest",
  "./assets/logo-combuses.webp",
  "./assets/icon-192.png",
  "./assets/icon-512.png",
  "./assets/icon-maskable-512.png",

  // Módulo: asistencia biométrica
  "./modulos/asistencia/asistencia-web.html",
  "./modulos/asistencia/asistencia.css",
  "./modulos/asistencia/asistencia.js",
  "./modulos/asistencia/supabase-config.js",
  "./modulos/asistencia/modo-portal.css",
  "./modulos/asistencia/modo-portal.js",
  "./modulos/asistencia/assets/logo-combuses.webp",

  // Módulo: despachos aeropuerto
  "./modulos/aeropuerto/aplicacion-aeropuerto.html",
  "./modulos/aeropuerto/css/style.css",
  "./modulos/aeropuerto/css/modo-conductor.css",
  "./modulos/aeropuerto/js/config.js",
  "./modulos/aeropuerto/js/main.js",
  "./modulos/aeropuerto/js/modo-conductor.js",
  "./modulos/aeropuerto/icons/favicon.svg",
];

const CDN_PRECACHE = [
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
];

// Hosts cuyas respuestas nunca deben quedar en caché: datos que tienen que
// llegar frescos sí o sí (marcas de asistencia, fila del aeropuerto, sesión).
const HOSTS_SIN_CACHE = ["supabase.co", "supabase.in", "connect.pabbly.com"];

// -------------------------------------------------------------- install
self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_APP);
    // cache.addAll() falla entero si un solo recurso falla; los añadimos uno a
    // uno para que un archivo faltante no impida instalar el service worker.
    await Promise.all(
      APP_SHELL.map((url) =>
        cache.add(new Request(url, { cache: "reload" })).catch(() => null)
      )
    );

    const cdn = await caches.open(CACHE_CDN);
    await Promise.all(
      CDN_PRECACHE.map((url) =>
        cdn.add(new Request(url, { mode: "cors", cache: "reload" })).catch(() => null)
      )
    );

    // Sin skipWaiting: la versión nueva queda en espera y el portal decide
    // cuándo activarla. Activarla al instante dejaría la página vieja pidiendo
    // archivos a la caché nueva, y recargar a mitad de una marca de asistencia
    // la perdería. (La primera instalación, sin versión anterior, se activa
    // sola de todos modos.)
  })());
});

// ------------------------------------------------------------- activate
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const vigentes = [CACHE_APP, CACHE_CDN, CACHE_TILES, CACHE_DATOS];
    const claves = await caches.keys();
    await Promise.all(
      claves
        .filter((k) => k.startsWith("portal-") && !vigentes.includes(k))
        .map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  const tipo = event.data && event.data.type;
  if (tipo === "SKIP_WAITING") self.skipWaiting();
  // El portal pregunta qué versión trae el service worker en espera, para
  // anunciarla antes de instalarla.
  if (tipo === "VERSION" && event.ports && event.ports[0]) event.ports[0].postMessage(VERSION);
});

// ---------------------------------------------------------------- fetch
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  let url;
  try { url = new URL(req.url); } catch (_) { return; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return;

  // Datos vivos: siempre a la red, nunca desde caché.
  if (HOSTS_SIN_CACHE.some((h) => url.hostname.endsWith(h))) return;

  // Navegaciones: red primero para tomar la versión nueva, con el shell como
  // red de seguridad si el conductor está sin señal.
  if (req.mode === "navigate") {
    event.respondWith(navegacion(req));
    return;
  }

  if (esTile(url)) {
    event.respondWith(redPrimeroConTope(req, CACHE_TILES, MAX_TILES));
    return;
  }

  if (esCsvNomina(url)) {
    event.respondWith(redPrimero(req, CACHE_DATOS));
    return;
  }

  if (url.origin !== self.location.origin) {
    event.respondWith(cachePrimero(req, CACHE_CDN));
    return;
  }

  event.respondWith(cachePrimeroRevalidando(req, CACHE_APP));
});

// ------------------------------------------------------------ estrategias
async function navegacion(req) {
  try {
    // "no-cache" revalida con el servidor en vez de fiarse de la caché HTTP:
    // GitHub Pages sirve el HTML con max-age=600, y sin esto una versión recién
    // publicada podía tardar 10 minutos en llegar aunque se recargara.
    const res = await fetch(req.url, { cache: "no-cache", credentials: "same-origin" });
    // Una navegación no acepta una respuesta que ya siguió una redirección:
    // se le devuelve la redirección y el navegador la sigue.
    if (res.redirected) return Response.redirect(res.url, 302);
    if (res && res.ok) {
      const cache = await caches.open(CACHE_APP);
      cache.put(req, res.clone());
    }
    return res;
  } catch (_) {
    const cache = await caches.open(CACHE_APP);
    return (await cache.match(req)) ||
      (await cache.match("./index.html")) ||
      (await cache.match("./")) ||
      new Response("Sin conexión", { status: 503, statusText: "Sin conexión" });
  }
}

async function cachePrimero(req, nombreCache) {
  const cache = await caches.open(nombreCache);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res && (res.ok || res.type === "opaque")) cache.put(req, res.clone());
    return res;
  } catch (err) {
    return new Response("Sin conexión", { status: 503, statusText: "Sin conexión" });
  }
}

async function cachePrimeroRevalidando(req, nombreCache) {
  const cache = await caches.open(nombreCache);
  const hit = await cache.match(req);

  const enRed = fetch(req)
    .then((res) => {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    })
    .catch(() => null);

  if (hit) return hit;                       // servimos ya, actualizamos detrás
  const res = await enRed;
  return res || new Response("Sin conexión", { status: 503, statusText: "Sin conexión" });
}

async function redPrimero(req, nombreCache) {
  const cache = await caches.open(nombreCache);
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (_) {
    return (await cache.match(req)) ||
      new Response("Sin conexión", { status: 503, statusText: "Sin conexión" });
  }
}

async function redPrimeroConTope(req, nombreCache, tope) {
  const cache = await caches.open(nombreCache);
  try {
    const res = await fetch(req);
    if (res && (res.ok || res.type === "opaque")) {
      cache.put(req, res.clone()).then(() => podar(nombreCache, tope));
    }
    return res;
  } catch (_) {
    return (await cache.match(req)) ||
      new Response("", { status: 504, statusText: "Tile no disponible" });
  }
}

// FIFO simple: las entradas más viejas de la caché salen primero.
async function podar(nombreCache, tope) {
  const cache = await caches.open(nombreCache);
  const claves = await cache.keys();
  if (claves.length <= tope) return;
  await Promise.all(claves.slice(0, claves.length - tope).map((k) => cache.delete(k)));
}

// ------------------------------------------------------------- ayudantes
function esTile(url) {
  return /(^|\.)tile\.openstreetmap\.org$/.test(url.hostname) ||
         /(^|\.)basemaps\.cartocdn\.com$/.test(url.hostname) ||
         /(^|\.)tile\.opentopomap\.org$/.test(url.hostname);
}

function esCsvNomina(url) {
  return url.hostname.endsWith("docs.google.com") && url.pathname.indexOf("/spreadsheets/") >= 0;
}
