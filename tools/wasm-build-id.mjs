// Appends a custom section "bl_build_id" to engine.wasm: the start of the SHA-256 of the
// module without this section. The engine reads it at runtime (engine/src/BytecodeCache.cpp),
// so the ID always matches the running code. tools/engine-manifest.mjs copies it into
// manifest.json. Called by the engine build (engine/engine.cmake).
//
//   node tools/wasm-build-id.mjs <engine.wasm>
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { wasmSections } from './wasm-sections.mjs';

const NAME = 'bl_build_id';

function leb(value) {
  const out = [];
  do {
    const byte = value & 0x7f;
    value = Math.floor(value / 128);
    out.push(value ? byte | 0x80 : byte);
  } while (value);
  return Buffer.from(out);
}

const file = process.argv[2];
if (!file) {
  console.error('Usage: wasm-build-id.mjs <engine.wasm>');
  process.exit(2);
}
const wasm = readFileSync(file);
if (!wasm.subarray(0, 4).equals(Buffer.from('\0asm', 'latin1'))) {
  console.error(`${file}: not WebAssembly`);
  process.exit(1);
}

const parts = [wasm.subarray(0, 8)];
for (const s of wasmSections(wasm)) {
  if (s.name !== NAME) parts.push(wasm.subarray(s.start, s.end));
}
const module = Buffer.concat(parts);
const buildId = createHash('sha256').update(module).digest('hex').slice(0, 16);
const payload = Buffer.concat([leb(NAME.length), Buffer.from(NAME), Buffer.from(buildId)]);
writeFileSync(file, Buffer.concat([module, Buffer.from([0]), leb(payload.length), payload]));
console.log(`Build ID ${buildId}`);
