// Oak service worker - scoped to Web Push only (waking a backgrounded/
// locked device for an incoming Comm call or chat message), ported from
// QTI's own sw.js. Deliberately NOT porting QTI's other job (offline
// asset-shell caching) - a different concern, not requested here.
"use strict";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  if (!event.data) return;
  let payload = { title: "Oak", body: "", icon: "/icon-192.png", data: {} };
  try {
    payload = { ...payload, ...event.data.json() };
  } catch (e) {
    /* non-JSON push payload - use the defaults above */
  }
  const isCall = payload.data && payload.data.type === "call";
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: payload.icon,
      vibrate: isCall ? [500, 200, 500, 200, 500, 200, 500] : [200, 100, 200],
      tag: isCall ? "oak-comm-call" : "oak-comm-message",
      renotify: true,
      requireInteraction: isCall,
      data: payload.data,
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: "window" }).then((list) => {
      for (const c of list) {
        if (c.url.includes("/live.html") && "focus" in c) return c.focus();
      }
      if (clients.openWindow) return clients.openWindow("/live.html");
    })
  );
});
