/* Service worker del Optimizador de rutas CFE.
   - La página y las librerías quedan guardadas en el teléfono: si la señal se cae, la app abre igual.
   - Los mosaicos del mapa que ya se vieron se guardan (hasta MAX_TILES) para seguir viéndolos sin señal.
   - El servidor (/optimize) y el ruteo (OSRM) nunca se guardan: siempre van a la red. */
const VERSION = 'cfe-rutas-v1';
const APP = VERSION + '-app';
const LIBS = VERSION + '-libs';
const TILES = VERSION + '-tiles';
const MAX_TILES = 3000;

const APP_FILES = [
  './', 'index.html', 'script.js', 'styles.css', 'logo-cfe.png',
  'manifest.webmanifest', 'icon-192.png', 'icon-512.png'
];
const LIB_FILES = [
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.css',
  'https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.Default.css',
  'https://unpkg.com/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js',
  'https://unpkg.com/papaparse@5.4.1/papaparse.min.js',
  'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js'
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const a = await caches.open(APP);
    await Promise.all(APP_FILES.map(u => a.add(u).catch(() => null)));
    const l = await caches.open(LIBS);
    await Promise.all(LIB_FILES.map(u => fetch(u, { mode: 'no-cors' }).then(r => l.put(u, r)).catch(() => null)));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => !k.startsWith(VERSION)).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

async function trimTiles() {
  const c = await caches.open(TILES);
  const keys = await c.keys();
  if (keys.length > MAX_TILES) {
    await Promise.all(keys.slice(0, keys.length - MAX_TILES).map(k => c.delete(k)));
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                       // /optimize (POST) siempre a la red
  const url = new URL(req.url);
  if (/project-osrm\.org$/.test(url.hostname)) return;    // ruteo: siempre a la red
  if (url.pathname.endsWith('.json') && url.origin === location.origin) return; // datos (productividad, etc.)

  // mosaicos del mapa: primero lo guardado, si no, la red (y se guarda)
  if (/tile\.openstreetmap\.org$/.test(url.hostname)) {
    e.respondWith((async () => {
      const c = await caches.open(TILES);
      const hit = await c.match(req);
      if (hit) return hit;
      try {
        const r = await fetch(req);
        if (r && (r.ok || r.type === 'opaque')) { c.put(req, r.clone()); trimTiles(); }
        return r;
      } catch (err) {
        return hit || Response.error();
      }
    })());
    return;
  }

  // librerías (CDN): primero lo guardado
  if (url.origin !== location.origin) {
    e.respondWith((async () => {
      const c = await caches.open(LIBS);
      const hit = await c.match(req, { ignoreVary: true }) || await c.match(req.url);
      if (hit) return hit;
      try {
        const r = await fetch(req);
        if (r && (r.ok || r.type === 'opaque')) c.put(req, r.clone());
        return r;
      } catch (err) { return Response.error(); }
    })());
    return;
  }

  // la app: primero la red (para recibir actualizaciones); sin señal, lo guardado
  e.respondWith((async () => {
    const c = await caches.open(APP);
    try {
      const r = await fetch(req);
      if (r && r.ok) c.put(req, r.clone());
      return r;
    } catch (err) {
      return (await c.match(req, { ignoreSearch: true })) || (await c.match('index.html')) || Response.error();
    }
  })());
});
