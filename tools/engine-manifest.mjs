// Writes manifest.json next to the engine files of a packaged engine (tools/package-engine.sh):
// product version, WebKit and Emscripten pins, SHA256 and size of every engine file and what an
// embedding page needs.
//
//   node tools/engine-manifest.mjs <engine-folder>
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pins, version } from './pins.mjs';

const dir = process.argv[2];
if (!dir) {
  console.error('Usage: engine-manifest.mjs <engine-folder>');
  process.exit(2);
}

const files = {};
// The chunks engine.deferred-<n>.wasm of a split engine (#238)
const chunks = readdirSync(dir)
  .filter((name) => /^engine\.deferred-\d+\.wasm$/.test(name))
  .sort((a, b) => Number(a.match(/\d+/)) - Number(b.match(/\d+/)));
for (const name of ['engine.js', 'engine.wasm', ...chunks, 'engine.data']) {
  const data = readFileSync(path.join(dir, name));
  files[name] = { sha256: createHash('sha256').update(data).digest('hex'), size: data.length };
}

const manifest = {
  name: 'browser-lite-engine',
  version,
  webkit: { tag: pins.WEBKIT_TAG, commit: pins.WEBKIT_COMMIT },
  emsdk: pins.EMSDK_VERSION,
  files,
  requires: { crossOriginIsolated: true, sameOriginScript: true },
};
writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
