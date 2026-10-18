import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';

// The engine needs SharedArrayBuffer, so every response of this route makes the page cross-origin
// isolated. Production servers must send the same headers.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

// browser-lite-server (relay under /wisp/), started separately
const relay = process.env.RELAY_URL ?? 'http://127.0.0.1:5001';

// The service worker of the core: sw.js loads media-sw.js next to itself
const swDir = path.join(
  path.dirname(createRequire(import.meta.url).resolve('@browser-lite/core')),
  'sw',
);
const swFiles = ['sw.js', 'media-sw.js'];

/** Serves sw.js and media-sw.js of the core at the root in development, copies them in the build. */
function mediaServiceWorker(): Plugin {
  return {
    name: 'media-service-worker',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const name = new URL(req.url ?? '/', 'http://localhost').pathname.slice(1);
        if (!swFiles.includes(name)) return next();
        readFile(path.join(swDir, name)).then((body) => {
          res.writeHead(200, { ...isolation, 'Content-Type': 'text/javascript' }).end(body);
        }, next);
      });
    },
    async generateBundle() {
      for (const fileName of swFiles)
        this.emitFile({
          type: 'asset',
          fileName,
          source: await readFile(path.join(swDir, fileName)),
        });
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [mediaServiceWorker()],
  server: { headers: isolation, proxy: { '/wisp/': { target: relay, ws: true } } },
  preview: { headers: isolation, proxy: { '/wisp/': { target: relay, ws: true } } },
  build: {
    target: 'es2023',
    // The audio worklet of the core must stay a file of the same origin
    assetsInlineLimit: (file) => (file.endsWith('.js') ? false : undefined),
  },
});
