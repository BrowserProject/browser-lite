// @ts-check
// Standalone service worker for @browser-lite/core: the media part and nothing else. Use it when
// the site has no service worker of its own; otherwise importScripts('media-sw.js') there.

importScripts('media-sw.js');

{
  const sw = /** @type {ServiceWorkerGlobalScope} */ (/** @type {unknown} */ (self));
  sw.addEventListener('install', () => sw.skipWaiting());
  // Claims the pages without holding up the activation: until then their requests wait, also the
  // script of a new engine worker, which is a client claim() waits for (Firefox ended that after
  // about 60 s, and the worker did not load)
  sw.addEventListener('activate', () => {
    sw.clients.claim().catch(() => {});
  });
}
