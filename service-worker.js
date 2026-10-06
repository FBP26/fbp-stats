const CACHE_NAME = "fbp-shell-v54";
const APP_SHELL = ["./", "./index.html", "./live-client.js", "./historical-ui.js", "./teams.js", "./map.js", "./map.css", "./manifest.webmanifest", "./icons/fbp-192.png", "./icons/fbp-512.png"];

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
  let payload = {};
  try { payload = event.data?.json() || {}; } catch { payload = { body: event.data?.text() || "" }; }
  const icon = new URL("icons/fbp-192.png", self.registration.scope).href;
  const url = typeof payload.url === "string" ? payload.url : "./";
  event.waitUntil(self.registration.showNotification(String(payload.title || "FBP"), {
    body: String(payload.body || ""),
    icon,
    badge: icon,
    tag: String(payload.tag || "fbp-notification"),
    data: { url },
  }));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const target = new URL(String(event.notification.data?.url || "./"), self.registration.scope).href;
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(windows => {
    const appWindow = windows.find(client => client.url.startsWith(self.registration.scope));
    return appWindow ? appWindow.navigate(target).then(() => appWindow.focus()) : self.clients.openWindow(target);
  }));
});
