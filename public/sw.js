// Service worker: caches the app shell only. API calls and ticket data are never cached.
const SHELL = "shell-v5";
const FILES = ["/", "/index.html", "/tickets.html", "/admin.html", "/offline.html",
  "/css/style.css", "/js/app.js", "/js/config.js", "/js/index.js", "/js/tickets.js", "/js/admin.js",
  "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/sprite.svg"];
const RUNTIME_HOSTS = ["www.gstatic.com", "fonts.googleapis.com", "fonts.gstatic.com"];

self.addEventListener("install", e =>
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES)).then(() => self.skipWaiting())));

self.addEventListener("activate", e =>
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== SHELL).map(k => caches.delete(k))))
    .then(() => self.clients.claim())));

self.addEventListener("fetch", e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET") return;
  const isRuntime = RUNTIME_HOSTS.includes(url.hostname)
    && (url.hostname !== "www.gstatic.com" || url.pathname.startsWith("/firebasejs/"));
  if (url.origin !== location.origin && !isRuntime) return;   // API and Auth: network only
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).catch(() =>
      caches.match(req, { ignoreSearch: true }).then(r => r || caches.match("/offline.html"))));
    return;
  }
  e.respondWith(caches.match(req).then(r => r || fetch(req).then(res => {
    if (isRuntime && res.ok) { const copy = res.clone(); caches.open(SHELL).then(c => c.put(req, copy)); }
    return res;
  })));
});
