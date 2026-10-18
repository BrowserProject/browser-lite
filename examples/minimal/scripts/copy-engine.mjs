// Copies the engine build (engine.js, engine.wasm, engine.data) from ENGINE_DIR into
// public/engine/, where Vite serves it in development and copies it into the build.
//   ENGINE_DIR=/path/to/engine npm run copy-engine
import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const source = process.env.ENGINE_DIR;
if (!source) {
  console.error('Set ENGINE_DIR to the folder with engine.js, engine.wasm and engine.data');
  process.exit(1);
}
const target = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'engine');
await mkdir(target, { recursive: true });
for (const file of ['engine.js', 'engine.wasm', 'engine.data'])
  await copyFile(path.join(path.resolve(source), file), path.join(target, file));
console.log(`Engine copied to ${target}`);
