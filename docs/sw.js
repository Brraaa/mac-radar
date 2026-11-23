// Service worker Mac Radar : reçoit les notifications push et ouvre l'offre au toucher.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: "Mac Radar", body: event.data ? event.data.text() : "" }; }
  const title = data.title || "Mac Radar";
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || "Nouvelle offre MacBook Pro",
    icon: "icon-192.png",
    badge: "icon-192.png",
    tag: data.tag || undefined,
    data: { url: data.url || "./" },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "./";
  event.waitUntil(self.clients.openWindow(url));
});
