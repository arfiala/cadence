// Cadence service worker (ISC-162). Exists SOLELY so Chromium treats the app
// as installable (an installed PWA requires a registered fetch handler). It is
// a pure no-op passthrough: no Cache storage, no offline logic, no push. Every
// request falls through to the browser's default network fetch.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {
  // Intentionally empty: the handler does not intercept the response, so the
  // browser performs its normal network request. No Cache storage is used.
});
