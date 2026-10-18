// @ts-check
// Standalone service worker for @browser-lite/core: the media part and nothing else. Use it when
// the site has no service worker of its own; otherwise importScripts('media-sw.js') there.

importScripts('media-sw.js');

{
  const sw = /** @type {ServiceWorkerGlobalScope} */ (/** @type {unknown} */ (self));
  sw.addEventListener('install', () => sw.skipWaiting());
  sw.addEventListener('activate', (event) => event.waitUntil(sw.clients.claim()));
}
