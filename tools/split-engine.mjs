// Splits the linked engine (#238) into engine.wasm, the code the start and common pages run, and
// chunks engine.deferred-<n>.wasm of the rest, which the host loads after the start
// (engine/js/deferred.js):
//  1. engine.wasm keeps the functions of engine/hot-functions.txt (tools/hot-functions.mjs) that
//     ran, functions newer than that list, and what the bl_ exports and the functions the page
//     main thread ran reach by direct calls (a chunk would block the page while it loads, and
//     cannot load at all while the page goes away).
//  2. The rest goes into chunks of about CHUNK_BYTES, sorted by class, so a thread that needs
//     deferred code before everything arrived waits for one chunk only (binaryen's wasm-split).
//  3. wasm-split's placeholders (one imported JS function per deferred function, about 50000,
//     which made every instance in every thread 100 ms slower) become trampolines inside
//     engine.wasm: they call the import bl_load_deferred(chunk) (engine/src/main.cpp),
//     then the slot, which the instance of the chunk has filled meanwhile.
//  4. The engine.wasm functions the chunks call go into one exported table and small functions
//     merged into each chunk call through it, so engine.wasm needs no export per function
//     (another 25 ms per instance).
// engine.wasm gets the custom section "bl.deferred" with the number of chunks. The input stays
// next to them as engine.full.wasm (with names, for tools/hot-functions.mjs).
//
//   node tools/split-engine.mjs <engine.wasm> <hot-functions.txt>   (BL_SPLIT_KEEP=1 keeps the work files)
import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { nameHash, readHotList } from './hot-functions-file.mjs';
import {
  encodeLEB,
  functionNames,
  functionSizes,
  functionTypes,
  wasmExports,
  wasmImports,
  withExports,
} from './wasm-binary.mjs';

// Code of the functions per chunk of the deferred part (before compression, about a fifth after);
// a class larger than that stays together up to MAX_CHUNK_BYTES, below the 8 MB up to which Chrome
// compiles a module synchronously on the page main thread
const CHUNK_BYTES = 1_000_000;
const MAX_CHUNK_BYTES = 4_000_000;

// Features of the engine build (the linked module has no target_features section to read them)
const FEATURES = [
  '--enable-threads',
  '--enable-bulk-memory',
  '--enable-bulk-memory-opt',
  '--enable-simd',
  '--enable-nontrapping-float-to-int',
  '--enable-sign-ext',
  '--enable-mutable-globals',
  '--enable-reference-types',
  '--enable-multivalue',
  '--enable-call-indirect-overlong',
];

const [input, listFile] = process.argv.slice(2);
if (!input || !listFile) {
  console.error('Usage: split-engine.mjs <engine.wasm> <hot-functions.txt>');
  process.exit(2);
}
const dir = path.dirname(input);
const work = mkdtempSync(path.join(dir, '.split-'));
const file = (name) => path.join(work, name);

function run(tool, args) {
  const result = spawnSync(tool, [...args, ...FEATURES], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (result.status !== 0) throw new Error(`${tool} failed: ${result.error ?? result.status}`);
}

/** Direct calls (caller name -> callee names) as printed by wasm-opt. */
async function callGraph(wasm) {
  const child = spawn('wasm-opt', [wasm, '--print-call-graph', '-o', '/dev/null', ...FEATURES], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  const edges = new Map();
  for await (const line of readline.createInterface({ input: child.stdout })) {
    const match = /^ {2}"(.*)" -> "(.*)"; \/\/ call$/.exec(line);
    if (!match) continue;
    const callees = edges.get(match[1]) ?? [];
    callees.push(match[2]);
    edges.set(match[1], callees);
  }
  const status = await exited;
  if (status !== 0) throw new Error(`wasm-opt --print-call-graph failed: ${status}`);
  return edges;
}

/** Text format type names of function signatures, shared by the modules written here. */
class Signatures {
  keys = new Map();
  /** The name of the signature `{ params, results }`, declared by {@link declarations}. */
  name({ params, results }) {
    const key = `${params.join(' ')}>${results.join(' ')}`;
    if (!this.keys.has(key)) this.keys.set(key, { name: `$t${this.keys.size}`, params, results });
    return this.keys.get(key).name;
  }
  declarations() {
    return [...this.keys.values()].map(({ name, params, results }) => {
      const param = params.length ? ` (param ${params.join(' ')})` : '';
      const result = results.length ? ` (result ${results.join(' ')})` : '';
      return `  (type ${name} (func${param}${result}))`;
    });
  }
}

/** Class of a C++ function (namespace for free functions), name prefix of a C function. */
function groupOf(name) {
  let base = name.replace(/\(.*$/s, '');
  for (let previous; previous !== base; ) {
    previous = base;
    base = base.replace(/<[^<>]*>/g, '');
  }
  const parts = base.split('::');
  if (parts.length > 1) return parts.slice(0, -1).join('::');
  return /^[A-Za-z0-9]+_/.exec(base)?.[0] ?? base;
}

/** `text` as a quoted string of the text format (bytes outside printable ASCII escaped). */
function quoted(text) {
  let out = '"';
  for (const byte of Buffer.from(text))
    out +=
      byte >= 0x20 && byte < 0x7f && byte !== 0x22 && byte !== 0x5c
        ? String.fromCharCode(byte)
        : `\\${byte.toString(16).padStart(2, '0')}`;
  return `${out}"`;
}

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const callArgs = (params) => params.map((_, index) => ` (local.get ${index})`).join('');

function limits({ min, max, shared }) {
  return `${min}${max === undefined ? '' : ` ${max}`}${shared ? ' shared' : ''}`;
}

function customSection(name, text) {
  const payload = Buffer.concat([
    encodeLEB(Buffer.byteLength(name)),
    Buffer.from(name),
    Buffer.from(text),
  ]);
  return Buffer.concat([Buffer.from([0]), encodeLEB(payload.length), payload]);
}

/** Writes `wat`, assembles it and returns the path of the binary. */
function assemble(name, lines) {
  writeFileSync(file(`${name}.wat`), `${lines.join('\n')}\n`);
  run('wasm-as', [file(`${name}.wat`), '-o', file(`${name}.wasm`)]);
  return file(`${name}.wasm`);
}

async function main() {
  const full = readFileSync(input);
  const names = functionNames(full);
  if (!names.size) throw new Error(`${input} has no function names (link with --profiling-funcs)`);
  const functionImports = wasmImports(full).filter((entry) => entry.kind === 'function');
  const importedFunctions = functionImports.length;
  const load = functionImports.find((_, index) => names.get(index) === 'bl_load_deferred');
  if (!load) throw new Error(`${input} does not import bl_load_deferred (engine/src/main.cpp)`);

  // 1. What stays
  const hot = readHotList(listFile);
  const keep = new Set();
  const roots = [];
  for (const [index, name] of names) {
    if (index < importedFunctions) continue;
    const entry = hot.get(nameHash(name));
    // Cold functions are deferred; functions newer than the list stay
    if (entry?.cold) continue;
    keep.add(name);
    if (entry?.main) roots.push(name);
  }
  // The host's API (bl_ exports, abi.json) runs on the page main thread, also while the page goes
  // away (storage flush), when a chunk can no longer be read synchronously
  for (const entry of wasmExports(full)) {
    const name = names.get(entry.index);
    if (entry.kind === 'function' && /^bl_[a-z]/.test(name ?? '')) roots.push(name);
  }
  const edges = await callGraph(input);
  const reached = new Set();
  while (roots.length) {
    const name = roots.pop();
    if (reached.has(name)) continue;
    reached.add(name);
    for (const callee of edges.get(name) ?? []) roots.push(callee);
  }
  const defined = new Set(
    [...names].filter(([index]) => index >= importedFunctions).map(([, name]) => name),
  );
  for (const name of reached) if (defined.has(name)) keep.add(name);
  writeFileSync(file('keep.txt'), `${[...keep].join('\n')}\n`);

  // 2. The rest in chunks of about CHUNK_BYTES, sorted by class, so a feature's code stays
  // together and a thread that needs it waits only for its chunk
  const sizes = functionSizes(full);
  const cold = [...names]
    .filter(([index, name]) => index >= importedFunctions && !keep.has(name))
    .map(([index, name]) => ({
      name,
      size: sizes[index - importedFunctions],
      group: groupOf(name),
    }))
    .sort((a, b) => compare(a.group, b.group) || compare(a.name, b.name));
  const chunks = [[]];
  let chunkBytes = 0;
  for (const [index, entry] of cold.entries()) {
    if (
      chunkBytes >= MAX_CHUNK_BYTES ||
      (chunkBytes >= CHUNK_BYTES && entry.group !== cold[index - 1].group)
    ) {
      chunks.push([]);
      chunkBytes = 0;
    }
    chunks.at(-1).push(entry.name);
    chunkBytes += entry.size;
  }
  writeFileSync(
    file('manifest.txt'),
    `${chunks.map((list, index) => `${index}\n${list.join('\n')}`).join('\n\n')}\n`,
  );
  run('wasm-split', [
    '--multi-split',
    input,
    `--manifest=${file('manifest.txt')}`,
    `--out-prefix=${file('deferred-')}`,
    '-o',
    file('primary.wasm'),
    '--import-namespace=primary',
    '--placeholder-namespace-prefix=placeholder',
    '--export-prefix=%',
    '-g',
  ]);

  // 3. Placeholders as trampolines: bl_load_deferred(chunk), then the slot
  let primary = readFileSync(file('primary.wasm'));
  const primaryTypes = functionTypes(primary);
  const placeholders = wasmImports(primary).filter((entry) =>
    entry.module.startsWith('placeholder.'),
  );
  const slotTables = wasmExports(primary).filter(
    (entry) => entry.kind === 'table' && entry.name.startsWith('%'),
  );
  if (slotTables.length !== 1) throw new Error('wasm-split made more than one slot table');
  const trampolines = chunks.map((_, chunk) => {
    const own = placeholders.filter((entry) => entry.module === `placeholder.${chunk}`);
    const signatures = new Signatures();
    const functions = own.map(({ name, type }) => {
      const signature = signatures.name(primaryTypes[type]);
      const args = callArgs(primaryTypes[type].params);
      return `  (func (export ${quoted(name)}) (type ${signature}) (call $load (i32.const ${chunk})) (call_indirect $slots (type ${signature})${args} (i32.const ${name})))`;
    });
    return assemble(`trampolines-${chunk}`, [
      '(module',
      ...signatures.declarations(),
      `  (import ${quoted(load.module)} ${quoted(load.name)} (func $load (param i32)))`,
      `  (import "primary" ${quoted(slotTables[0].name)} (table $slots 0 funcref))`,
      ...functions,
      ')',
    ]);
  });
  run('wasm-merge', [
    file('primary.wasm'),
    'primary',
    ...trampolines.flatMap((wasm, chunk) => [wasm, `placeholder.${chunk}`]),
    '-o',
    file('primary-1.wasm'),
    '-g',
  ]);

  // 4. engine.wasm functions for the chunks through one table instead of an export each
  const chunkFiles = chunks.map((_, chunk) => readFileSync(file(`deferred-${chunk}.wasm`)));
  const called = new Map();
  for (const bytes of chunkFiles) {
    const types = functionTypes(bytes);
    for (const entry of wasmImports(bytes)) {
      if (entry.module !== 'primary') throw new Error('a chunk imports from more than engine.wasm');
      if (entry.kind === 'function' && !called.has(entry.name))
        called.set(entry.name, { index: called.size, type: types[entry.type] });
    }
  }
  const tableSignatures = new Signatures();
  const tableImports = [...called].map(
    ([name, { index, type }]) =>
      `  (import "primary" ${quoted(name)} (func $f${index} (type ${tableSignatures.name(type)})))`,
  );
  const functionTable = assemble('function-table', [
    '(module',
    ...tableSignatures.declarations(),
    ...tableImports,
    `  (table (export "%bl_functions") ${called.size} ${called.size} funcref)`,
    `  (elem (i32.const 0) func${[...called.values()].map(({ index }) => ` $f${index}`).join('')})`,
    ')',
  ]);
  run('wasm-merge', [
    file('primary-1.wasm'),
    'primary',
    functionTable,
    'bl_function_table',
    '-o',
    file('primary-2.wasm'),
    '-g',
  ]);
  primary = withExports(
    readFileSync(file('primary-2.wasm')),
    (entry) =>
      !/^\d+$/.test(entry.name) &&
      !(entry.kind === 'function' && entry.name.startsWith('%') && called.has(entry.name)),
  );
  primary = Buffer.concat([primary, customSection('bl.deferred', String(chunks.length))]);

  const kinds = { memory: 'memory', table: 'table', global: 'global' };
  const outputs = chunkFiles.map((bytes, chunk) => {
    const types = functionTypes(bytes);
    const imports = wasmImports(bytes);
    const signatures = new Signatures();
    const lines = [];
    for (const [index, entry] of imports.entries()) {
      if (entry.kind === 'function') {
        const signature = signatures.name(types[entry.type]);
        const args = callArgs(types[entry.type].params);
        lines.push(
          `  (func (export ${quoted(entry.name)}) (type ${signature}) (call_indirect $functions (type ${signature})${args} (i32.const ${called.get(entry.name).index})))`,
        );
        continue;
      }
      const type =
        entry.kind === 'global'
          ? entry.mutable
            ? `(mut ${entry.valueType})`
            : entry.valueType
          : entry.kind === 'table'
            ? `${limits(entry.limits)} ${entry.element}`
            : limits(entry.limits);
      lines.push(
        `  (import "bl_primary" ${quoted(entry.name)} (${kinds[entry.kind]} $s${index} ${type})) (export ${quoted(entry.name)} (${kinds[entry.kind]} $s${index}))`,
      );
    }
    const calls = assemble(`calls-${chunk}`, [
      '(module',
      ...signatures.declarations(),
      `  (import "bl_primary" "%bl_functions" (table $functions ${called.size} ${called.size} funcref))`,
      ...lines,
      ')',
    ]);
    run('wasm-merge', [
      file(`deferred-${chunk}.wasm`),
      'deferred',
      calls,
      'primary',
      '-o',
      file(`deferred-${chunk}-1.wasm`),
      '-g',
    ]);
    return withExports(readFileSync(file(`deferred-${chunk}-1.wasm`)), () => false);
  });

  for (const name of readdirSync(dir))
    if (/^engine\.deferred.*\.wasm$/.test(name)) rmSync(path.join(dir, name));
  copyFileSync(input, path.join(dir, 'engine.full.wasm'));
  for (const [chunk, bytes] of outputs.entries())
    writeFileSync(path.join(dir, `engine.deferred-${chunk}.wasm`), bytes);
  writeFileSync(file('engine.wasm'), primary);
  renameSync(file('engine.wasm'), input);
  const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;
  const deferredBytes = outputs.reduce((sum, bytes) => sum + bytes.length, 0);
  console.log(
    `split-engine: ${keep.size} of ${names.size - importedFunctions} functions kept (${reached.size} reached from the main thread); engine.wasm ${mb(primary.length)}, ${chunks.length} chunks engine.deferred-<n>.wasm ${mb(deferredBytes)} (from ${mb(full.length)})`,
  );
}

try {
  await main();
} finally {
  if (!process.env.BL_SPLIT_KEEP) rmSync(work, { recursive: true, force: true });
}
