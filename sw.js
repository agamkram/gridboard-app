/** Local: stay off. Production: versioned shell. Never cache status.json. */
const CACHE = "gridboard-v3";

/* Cache keys include the query, so these must match the pages byte for byte.
   scripts/bump-version.py keeps them in step. */
const SHELL = [
  "/",
  "/about.html",
  "/styles.css?v=14",
  "/app.js?v=17",
  "/manifest.webmanifest",
  "/favicon.ico",
  "/favicon-32.png",
  "/favicon-64.png",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable-512.png",
  "/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    (async () => {
      const c = await caches.open(CACHE);
      await Promise.all(SHELL.map((url) => c.add(url).catch(() => {})));
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

function isSnapshot(url) {
  return url.pathname === "/status.json";
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/_vercel/")) return;
  if (isSnapshot(url)) return;
  event.respondWith(
    (async () => {
      try {
        const res = await fetch(req);
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      } catch (err) {
        const hit = await caches.match(req);
        if (hit) return hit;
        if (req.mode === "navigate") {
          const shell = await caches.match("/");
          if (shell) return shell;
        }
        return new Response("", { status: 504, statusText: "Offline" });
      }
    })()
  );
});
