/* Service Worker — Meal Planner v26
   Strategy:
   - Network-first for HTML (so updates land quickly)
   - Cache-first for static assets (CSS/JS/icons)
   - Same-origin only
*/
const CACHE_NAME = "meal-planner-v28";
// Asset URLs carry ?v=N to match index.html: a new index.html then never gets
// old JS/CSS from a previous version's cache-first entries. Bump N with CACHE_NAME.
const CORE_ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./fonts/fonts.css?v=26",
  "./fonts/bricolage-grotesque.woff2",
  "./fonts/figtree.woff2",
  "./assets/styles.css?v=26",
  "./assets/icons.js?v=26",
  "./assets/app.js?v=26",
  "./assets/cook.js?v=26",
  "./assets/plan.js?v=26",
  "./assets/vendor/qrcode.js?v=26",
  "./assets/sync.js?v=26",
  "./assets/scan.js?v=26",
  "./assets/pwa.js?v=26",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-180.png",
  "./icons/favicon.ico"
];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(CORE_ASSETS))
      .catch((err) => console.warn("SW pre-cache failed:", err))
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => k !== CACHE_NAME ? caches.delete(k) : Promise.resolve()));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;

  if (req.method !== "GET") return;

  let url;
  try { url = new URL(req.url); } catch { return; }
  if (url.origin !== self.location.origin) return;

  // Network-first for HTML / navigations
  const accept = req.headers.get("accept") || "";
  if (req.mode === "navigate" || accept.includes("text/html")) {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(CACHE_NAME);
        cache.put(req, fresh.clone()).catch(() => {});
        return fresh;
      } catch {
        const cached = await caches.match(req);
        return cached || (await caches.match("./index.html")) || new Response("Offline", { status: 503 });
      }
    })());
    return;
  }

  // Cache-first for static
  event.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) return cached;
    try {
      const fresh = await fetch(req);
      // Only cache successful, basic responses
      if (fresh && fresh.ok && fresh.type === "basic") {
        const cache = await caches.open(CACHE_NAME);
        cache.put(req, fresh.clone()).catch(() => {});
      }
      return fresh;
    } catch {
      return new Response("Offline", { status: 503 });
    }
  })());
});

// Cook-mode timer notifications: tapping one brings the app to the front.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (all.length) return all[0].focus();
    return self.clients.openWindow("./");
  })());
});
