const CACHE_NAME = "fbp-shell-v29";
const APP_SHELL = ["./", "./index.html", "./historical-ui.js", "./teams.js", "./map.js", "./map.css", "./manifest.webmanifest"];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))));
  self.clients.claim();
});

self.addEventListener("fetch", event => {
  if (event.request.mode === "navigate") {
    event.respondWith(fetch(event.request).catch(() => caches.match("./index.html")));
    return;
  }
  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin) return;
  const shellPath = `.${requestUrl.pathname.slice(self.registration.scope.length - self.location.origin.length - 1)}`;
  if (!APP_SHELL.includes(shellPath)) return;
  event.respondWith(fetch(event.request).then(response => {
    const copy = response.clone();
    event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy)));
    return response;
  }).catch(() => caches.match(event.request)));
});

self.addEventListener("push", event => {
  const payload = event.data?.json?.() || {};
  const title = String(payload.title || "FBP update");
  event.waitUntil(self.registration.showNotification(title, {
    body: String(payload.body || "Open FBP for the latest update."),
    tag: String(payload.tag || "fbp-update"),
    data: { url: String(payload.url || "./") },
  }));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "./", self.registration.scope).href;
  event.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then(windows => {
    const existing = windows.find(window => window.url.startsWith(self.registration.scope));
    return existing ? existing.focus() : clients.openWindow(target);
  }));
});