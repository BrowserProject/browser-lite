// Checks that the JS glue of the engine gets unsigned pointers (docs/architecture.md): the engine
// addresses up to 4 GiB (MAXIMUM_MEMORY), and a wasm32 pointer at or above 2 GiB reaches an EM_JS
// function as a negative number, which HEAPU8.slice() and friends count from the end of the memory.
// Emscripten converts the pointers of its own library functions and of EM_ASM, not those of EM_JS.
// So every EM_JS function in engine/src, engine/jit and engine/patches starts with `name >>>= 0;`
// for each of its pointer parameters, like the library functions of Emscripten.
//   node tests/contract/pointers-test.mjs
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const rel = (file) => path.relative(root, file).split(path.sep).join('/');

function walk(dir, pattern) {
  const result = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) result.push(...walk(full, pattern));
    else if (pattern.test(name)) result.push(full);
  }
  return result;
}

// Sources with their text; of a patch only the lines it adds
const sources = [
  ...walk(path.join(root, 'engine', 'src'), /\.(cpp|h)$/),
  ...walk(path.join(root, 'engine', 'jit'), /\.(cpp|h)$/),
].map((file) => ({ name: rel(file), text: readFileSync(file, 'utf8') }));
for (const file of walk(path.join(root, 'engine', 'patches'), /\.patch$/)) {
  const added = readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1))
    .join('\n');
  sources.push({ name: rel(file), text: added });
}

const problems = [];
let functions = 0;
let pointers = 0;
for (const { name, text } of sources) {
  for (const match of text.matchAll(
    /\bEM_(?:ASYNC_)?JS\(\s*[^,]+,\s*(\w+)\s*,\s*\(([^)]*)\)\s*,\s*\{/g,
  )) {
    functions++;
    const params = match[2]
      .split(',')
      .map((param) => param.trim())
      .filter((param) => param && param !== 'void');
    const wanted = params
      .filter((param) => param.includes('*') || /\bu?intptr_t\b/.test(param))
      .map((param) => param.match(/(\w+)\s*$/)?.[1] ?? param);
    if (!wanted.length) continue;
    pointers += wanted.length;
    // The conversions the body starts with
    const converted = new Set();
    let body = text.slice(match.index + match[0].length);
    for (;;) {
      const conversion = body.match(/^\s*(\w+)\s*>>>=\s*0\s*;/);
      if (!conversion) break;
      converted.add(conversion[1]);
      body = body.slice(conversion[0].length);
    }
    const missing = wanted.filter((param) => !converted.has(param));
    if (missing.length) problems.push(`${name} ${match[1]}: ${missing.join(', ')}`);
  }
}

const ok = problems.length === 0 && functions > 0;
console.log(
  `${ok ? 'ok  ' : 'FAIL'} every EM_JS function starts by making its pointer parameters unsigned` +
    ` (${functions} functions, ${pointers} pointers)${problems.length ? `: ${problems.join('; ')}` : ''}`,
);
if (!ok) process.exit(1);
