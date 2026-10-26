import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { coiHeaders, serveStatic } from '@browser-lite/server/static';
import { defineConfig, type Plugin } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));
// Engine build served under /engine/ by the dev server
const engineDir = path.resolve(here, '../..', process.env.BL_ENGINE_DIR ?? 'build/webcore/bin');
// browser-lite-server with the relay (/wisp/) and the profile (/profile/)
const server = process.env.BL_SERVER ?? 'http://localhost:5001';
// The service worker of the core (package export): sw.js loads media-sw.js next to itself
const swDir = path.dirname(createRequire(import.meta.url).resolve('@browser-lite/core/sw/sw.js'));
const SW_FILES = ['sw.js', 'media-sw.js'];
// Folder of the engine relative to the page, the same as in src/main.ts
const engineBase = process.env.VITE_ENGINE_BASE || 'engine/';

/** Engine files and the service worker of the core: served in development, copied in the build. */
function browserLite(): Plugin {
  return {
    name: 'browser-lite',
    configureServer(dev) {
      dev.middlewares.use((req, res, next) => {
        const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
        let served: Promise<boolean> | null = null;
        if (pathname.startsWith('/engine/'))
          served = serveStatic(req, res, engineDir, {
            urlPath: decodeURIComponent(pathname.slice('/engine'.length)),
          });
        else if (SW_FILES.includes(pathname.slice(1)))
          served = serveStatic(req, res, swDir, { urlPath: pathname });
        if (!served) return next();
        served.then((done) => done || next(), next);
      });
    },
    // The engine files start loading with the page instead of after the app script (two round
    // trips earlier); createBrowser's requests then take these responses
    transformIndexHtml: () => [
      ...['engine.wasm', 'engine.data'].map((file) => ({
        tag: 'link',
        attrs: { rel: 'preload', href: `${engineBase}${file}`, as: 'fetch', crossorigin: '' },
        injectTo: 'head-prepend' as const,
      })),
      {
        tag: 'link',
        attrs: { rel: 'preload', href: `${engineBase}engine.js`, as: 'script' },
        injectTo: 'head-prepend',
      },
    ],
    async generateBundle() {
      for (const fileName of SW_FILES)
        this.emitFile({
          type: 'asset',
          fileName,
          source: await readFile(path.join(swDir, fileName)),
        });
    },
  };
}

export default defineConfig({
  root: here,
  base: './',
  plugins: [browserLite()],
  server: {
    headers: coiHeaders(),
    proxy: { '/wisp/': { target: server, ws: true }, '/profile/': server },
  },
  preview: { headers: coiHeaders() },
  build: {
    target: 'es2023',
    // Worklets of the core (audio-worklet.js) stay files of the same origin
    assetsInlineLimit: (file) => (file.endsWith('.js') ? false : undefined),
  },
});
