// The site's own service worker. The media part of browser-lite comes first: it answers only
// requests below bl-media/ of this scope and messages with a field `bl`, and ignores the rest.
importScripts('media-sw.js');

self.addEventListener('install', () => self.skipWaiting());
// Control the open pages right away, so videos play on the first visit too. Not in waitUntil():
// requests wait until the activation ends, also the script of a new engine worker, a client that
// claim() waits for (docs/embedding.md)
self.addEventListener('activate', () => {
  self.clients.claim().catch(() => {});
});

const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

// The site's own fetch logic. Responses for the pages and the engine must keep their
// COOP/COEP/CORP headers, so this worker only answers its own URL and passes the rest through.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (
    url.origin !== location.origin ||
    url.pathname !== new URL('sw-info.json', registration.scope).pathname
  )
    return;
  event.respondWith(
    Response.json({ worker: 'example-site', scope: registration.scope }, { headers: isolation }),
  );
});
