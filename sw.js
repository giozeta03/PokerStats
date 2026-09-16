// ============================================================================
// POKERSTATS — service worker (versione "leggera")
// ============================================================================
// - Pagina, stile, codice e config: prima dalla RETE (sempre la versione più
//   recente dopo un push); la copia salvata si usa solo se manca la connessione.
// - Libreria dei grafici, icone, caratteri e moduli Firebase (file che non
//   cambiano): prima dalla COPIA SALVATA sul telefono, così si aprono subito.
// - I dati (Firestore) e il login non passano mai da qui.
//
// Se un giorno cambi i file in lib/ o icons/, aumenta VERSION (v2, v3…) per
// far scaricare a tutti le copie nuove.
// ============================================================================

const VERSION = "pokerstats-v1";
const PAGES = `${VERSION}-pages`;
const ASSETS = `${VERSION}-assets`;

const CORE_FILES = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./firebase-config.js",
  "./manifest.json"
];

const ASSET_FILES = [
  "./lib/chart.umd.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
  "./icons/favicon-32.png",
  "./icons/favicon-16.png",
  "./icons/favicon.ico"
];

// file esterni che non cambiano mai (l'indirizzo contiene la versione):
// moduli Firebase (www.gstatic.com/firebasejs/10.12.2/...) e file dei caratteri
const isImmutable = (url) =>
  (url.hostname === "www.gstatic.com" && url.pathname.startsWith("/firebasejs/")) ||
  url.hostname === "fonts.gstatic.com";
// fogli di stile dei caratteri: si usa la copia e intanto la si aggiorna
const REVALIDATE_HOSTS = ["fonts.googleapis.com"];

// salva i file uno per uno: se ne manca uno l'installazione non si blocca
async function precache(cacheName, files) {
  const cache = await caches.open(cacheName);
  await Promise.allSettled(files.map((f) => cache.add(new Request(f, { cache: "reload" }))));
}

self.addEventListener("install", (event) => {
  event.waitUntil(Promise.all([precache(PAGES, CORE_FILES), precache(ASSETS, ASSET_FILES)]));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

// prima la rete (con verifica sul server), poi la copia salvata
async function networkFirst(request) {
  const cache = await caches.open(PAGES);
  try {
    // le richieste di navigazione non accettano opzioni: si ricrea la richiesta
    const fresh = request.mode === "navigate"
      ? new Request(request.url, { cache: "no-cache", credentials: "same-origin" })
      : new Request(request, { cache: "no-cache" });
    const response = await fetch(fresh);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (err) {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    if (request.mode === "navigate") {
      const page = await cache.match("./index.html");
      if (page) return page;
    }
    throw err;
  }
}

// prima la copia salvata, altrimenti la rete (e la salva)
async function cacheFirst(request) {
  const cache = await caches.open(ASSETS);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok || response.type === "opaque") cache.put(request, response.clone());
  return response;
}

// usa subito la copia salvata e intanto scarica quella nuova
async function staleWhileRevalidate(request) {
  const cache = await caches.open(ASSETS);
  const cached = await cache.match(request);
  const update = fetch(request)
    .then((response) => {
      if (response.ok || response.type === "opaque") cache.put(request, response.clone());
      return response;
    })
    .catch(() => cached);
  return cached || update;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  if (url.origin === self.location.origin) {
    const isAsset = url.pathname.includes("/lib/") || url.pathname.includes("/icons/");
    event.respondWith(isAsset ? cacheFirst(request) : networkFirst(request));
    return;
  }
  if (isImmutable(url)) {
    event.respondWith(cacheFirst(request));
    return;
  }
  if (REVALIDATE_HOSTS.includes(url.hostname)) {
    event.respondWith(staleWhileRevalidate(request));
  }
  // tutto il resto (Firestore, login, ecc.) va direttamente in rete
});
