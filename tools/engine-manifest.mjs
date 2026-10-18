// Writes manifest.json next to the engine files of a packaged engine (tools/package-engine.sh):
// product version, build ID (custom section bl_build_id of engine.wasm, see
// tools/wasm-build-id.py), WebKit and Emscripten pins, SHA256 and size of every engine file and
// what an embedding page needs.
//
//   node tools/engine-manifest.mjs <engine-folder>
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pins, root, version } from './pins.mjs';
import { wasmSections } from './wasm-sections.mjs';

const dir = process.argv[2];
if (!dir) {
  console.error('Usage: engine-manifest.mjs <engine-folder>');
  process.exit(2);
}

const files = {};
for (const name of ['engine.js', 'engine.wasm', 'engine.data']) {
  const data = readFileSync(path.join(dir, name));
  files[name] = { sha256: createHash('sha256').update(data).digest('hex'), size: data.length };
}
const wasm = readFileSync(path.join(dir, 'engine.wasm'));
const section = wasmSections(wasm).find((s) => s.name === 'bl_build_id');
const buildId = section && wasm.subarray(section.payload, section.end).toString();
if (!buildId) {
  console.error('engine.wasm has no bl_build_id section (built without tools/wasm-build-id.py?)');
  process.exit(1);
}

const manifest = {
  name: 'browser-lite-engine',
  version,
  buildId,
  webkit: { tag: pins.WEBKIT_TAG, commit: pins.WEBKIT_COMMIT },
  emsdk: pins.EMSDK_VERSION,
  files,
  requires: { crossOriginIsolated: true, sameOriginScript: true },
};
writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
