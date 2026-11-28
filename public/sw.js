// Service worker: caches the app shell only. API calls and ticket data are never cached.
const SHELL = "shell-v22";
// Pages use clean URLs (no .html), matching firebase.json "cleanUrls"
const FILES = ["/", "/tickets", "/admin", "/profile", "/offline",
  "/css/style.css", "/js/app.js", "/js/config.js", "/js/index.js", "/js/tickets.js", "/js/admin.js", "/js/profile.js", "/js/theme.js", "/js/push.js",
  "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/sprite.svg?v=5"]; // bump ?v= here and in the pages when icons change
const RUNTIME_HOSTS = ["www.gstatic.com", "fonts.googleapis.com", "fonts.gstatic.com"];

// cache: "reload" skips the browser's HTTP cache so a new version never stores old files
self.addEventListener("install", e =>
  e.waitUntil(caches.open(SHELL)
    .then(c => c.addAll(FILES.map(f => new Request(f, { cache: "reload" }))))
    .then(() => self.skipWaiting())));
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
      caches.match(req, { ignoreSearch: true }).then(r => r || caches.match("/offline"))));
    return;
  }
  e.respondWith(caches.match(req).then(r => r || fetch(req).then(res => {
    if (isRuntime && res.ok) { const copy = res.clone(); caches.open(SHELL).then(c => c.put(req, copy)); }
    return res;
  })));
});

// Push notifications (sent by the API through Firebase Cloud Messaging as data-only messages)
self.addEventListener("push", e => {
  let payload = {};
  try { payload = e.data ? e.data.json() : {}; } catch { /* not JSON: show the generic text */ }
  const d = payload.data || payload;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(windows => {
    if (windows.some(w => w.visibilityState === "visible")) return; // an open page already shows it live
    return self.registration.showNotification(d.title || "AI Support Desk", {
      body: d.body || "You have a new reply.", tag: d.tag, renotify: !!d.tag,
      icon: "/icons/icon-192.png", badge: "/icons/icon-192.png", data: { url: d.url || "/tickets" },
    });
  }));
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || "/tickets", self.location.origin);
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(windows => {
    const open = windows.find(w => new URL(w.url).pathname === url.pathname);
    if (!open) return self.clients.openWindow(url.href);
    open.postMessage({ openTicket: url.searchParams.get("ticket") });
    return open.focus();
  }));
});
