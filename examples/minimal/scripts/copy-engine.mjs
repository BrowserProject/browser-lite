// Copies the engine build (engine.js, engine.wasm, engine.data, lazy/) from ENGINE_DIR into
// public/engine/, where Vite serves it in development and copies it into the build.
//   ENGINE_DIR=/path/to/engine npm run copy-engine
import { access, cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FILES = ['engine.js', 'engine.wasm', 'engine.data', 'lazy'];
if (!process.env.ENGINE_DIR) {
  console.error('Set ENGINE_DIR to the folder with engine.js, engine.wasm, engine.data and lazy/');
  process.exit(1);
}
// npm runs scripts in the package folder; INIT_CWD is where the command was typed
const source = path.resolve(process.env.INIT_CWD ?? process.cwd(), process.env.ENGINE_DIR);
try {
  await Promise.all(FILES.map((file) => access(path.join(source, file))));
} catch {
  console.error(`${source} does not contain ${FILES.join(', ')}`);
  process.exit(1);
}
const target = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'engine');
await mkdir(target, { recursive: true });
for (const file of FILES)
  await cp(path.join(source, file), path.join(target, file), { recursive: true });
console.log(`Engine copied to ${target}`);
