// Splits the linked engine (#238) into engine.wasm, the code the start and common pages run, and
// engine.deferred.wasm, the rest, which the host loads after the start (engine/js/deferred.js):
//  1. engine.wasm keeps the functions of engine/hot-functions.txt (tools/hot-functions.mjs) and
//     everything the page main thread reaches by direct calls from the exports and from the
//     functions it ran: it cannot wait for engine.deferred.wasm.
//  2. binaryen's wasm-split splits. Its placeholders (one imported JS function per deferred
//     function, about 50000, which made every instance in every thread 100 ms slower) become
//     trampolines inside engine.wasm: they call the import bl_load_deferred(slot)
//     (engine/src/main.cpp), then the slot, which the instance of engine.deferred.wasm has
//     filled meanwhile.
//  3. The engine.wasm functions that engine.deferred.wasm calls go into one exported table and
//     small functions merged into engine.deferred.wasm call through it, so engine.wasm needs no
//     export per function (another 25 ms per instance).
// engine.wasm gets the custom section "bl.deferred", which tells the host to load the rest. The
// input stays next to them as engine.full.wasm (with names, for tools/hot-functions.mjs).
//
//   node tools/split-engine.mjs <engine.wasm> <hot-functions.txt>   (BL_SPLIT_KEEP=1 keeps the work files)
import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdtempSync,
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
  functionTypes,
  wasmExports,
  wasmImports,
  withExports,
} from './wasm-binary.mjs';

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

function typeDeclarations(types, used) {
  return [...used].map((index) => {
    const { params, results } = types[index];
    const param = params.length ? ` (param ${params.join(' ')})` : '';
    const result = results.length ? ` (result ${results.join(' ')})` : '';
    return `  (type $t${index} (func${param}${result}))`;
  });
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
    const entry = index >= importedFunctions && hot.get(nameHash(name));
    if (!entry) continue;
    keep.add(name);
    if (entry.main) roots.push(name);
  }
  for (const entry of wasmExports(full))
    if (entry.kind === 'function' && names.has(entry.index)) roots.push(names.get(entry.index));
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

  // 2. Split, placeholders as trampolines
  run('wasm-split', [
    input,
    `--keep-funcs=@${file('keep.txt')}`,
    '-o1',
    file('primary.wasm'),
    '-o2',
    file('deferred.wasm'),
    '--import-namespace=primary',
    '--placeholder-namespace=placeholder',
    '--export-prefix=%',
    '-g',
  ]);
  let primary = readFileSync(file('primary.wasm'));
  const primaryTypes = functionTypes(primary);
  const placeholders = wasmImports(primary).filter((entry) =>
    entry.module.startsWith('placeholder'),
  );
  const placeholderModules = new Set(placeholders.map((entry) => entry.module));
  const slotTables = wasmExports(primary).filter(
    (entry) => entry.kind === 'table' && entry.name.startsWith('%'),
  );
  if (placeholderModules.size !== 1 || slotTables.length !== 1)
    throw new Error('wasm-split output not as expected (one placeholder module and slot table)');
  const trampolines = assemble('trampolines', [
    '(module',
    ...typeDeclarations(primaryTypes, new Set(placeholders.map((entry) => entry.type))),
    `  (import ${quoted(load.module)} ${quoted(load.name)} (func $load (param i32)))`,
    `  (import "primary" ${quoted(slotTables[0].name)} (table $slots 0 funcref))`,
    ...placeholders.map(({ name, type }) => {
      const args = callArgs(primaryTypes[type].params);
      return `  (func (export ${quoted(name)}) (type $t${type}) (call $load (i32.const ${name})) (call_indirect $slots (type $t${type})${args} (i32.const ${name})))`;
    }),
    ')',
  ]);
  run('wasm-merge', [
    file('primary.wasm'),
    'primary',
    trampolines,
    [...placeholderModules][0],
    '-o',
    file('primary-1.wasm'),
    '-g',
  ]);
  primary = withExports(readFileSync(file('primary-1.wasm')), (entry) => !/^\d+$/.test(entry.name));
  writeFileSync(file('primary-1.wasm'), primary);

  // 3. engine.wasm functions for engine.deferred.wasm through a table
  const deferred = readFileSync(file('deferred.wasm'));
  const deferredTypes = functionTypes(deferred);
  const deferredImports = wasmImports(deferred);
  if (deferredImports.some((entry) => entry.module !== 'primary'))
    throw new Error('engine.deferred.wasm imports from more than engine.wasm');
  const called = deferredImports.filter((entry) => entry.kind === 'function');
  const shared = deferredImports.filter((entry) => entry.kind !== 'function');
  const usedTypes = new Set(called.map((entry) => entry.type));
  const functionTable = assemble('function-table', [
    '(module',
    ...typeDeclarations(deferredTypes, usedTypes),
    ...called.map(
      ({ name, type }, index) =>
        `  (import "primary" ${quoted(name)} (func $f${index} (type $t${type})))`,
    ),
    `  (table (export "%bl_functions") ${called.length} ${called.length} funcref)`,
    `  (elem (i32.const 0) func${called.map((_, index) => ` $f${index}`).join('')})`,
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
  const onlyForDeferred = new Set(
    called.map((entry) => entry.name).filter((name) => name.startsWith('%')),
  );
  primary = withExports(
    readFileSync(file('primary-2.wasm')),
    (entry) => !(entry.kind === 'function' && onlyForDeferred.has(entry.name)),
  );

  const kinds = { memory: 'memory', table: 'table', global: 'global' };
  const calls = assemble('calls', [
    '(module',
    ...typeDeclarations(deferredTypes, usedTypes),
    ...shared.map((entry, index) => {
      const type =
        entry.kind === 'global'
          ? entry.mutable
            ? `(mut ${entry.valueType})`
            : entry.valueType
          : entry.kind === 'table'
            ? `${limits(entry.limits)} ${entry.element}`
            : limits(entry.limits);
      return `  (import "bl_primary" ${quoted(entry.name)} (${kinds[entry.kind]} $s${index} ${type})) (export ${quoted(entry.name)} (${kinds[entry.kind]} $s${index}))`;
    }),
    `  (import "bl_primary" "%bl_functions" (table $functions ${called.length} ${called.length} funcref))`,
    ...called.map(({ name, type }, index) => {
      const args = callArgs(deferredTypes[type].params);
      return `  (func (export ${quoted(name)}) (type $t${type}) (call_indirect $functions (type $t${type})${args} (i32.const ${index})))`;
    }),
    ')',
  ]);
  run('wasm-merge', [
    file('deferred.wasm'),
    'deferred',
    calls,
    'primary',
    '-o',
    file('deferred-1.wasm'),
    '-g',
  ]);
  const deferredOut = withExports(readFileSync(file('deferred-1.wasm')), () => false);

  primary = Buffer.concat([primary, customSection('bl.deferred', 'engine.deferred.wasm')]);

  copyFileSync(input, path.join(dir, 'engine.full.wasm'));
  writeFileSync(file('engine.wasm'), primary);
  writeFileSync(file('engine.deferred.wasm'), deferredOut);
  renameSync(file('engine.deferred.wasm'), path.join(dir, 'engine.deferred.wasm'));
  renameSync(file('engine.wasm'), input);
  const mb = (bytes) => `${(bytes.length / 1e6).toFixed(1)} MB`;
  console.log(
    `split-engine: ${keep.size} of ${names.size - importedFunctions} functions kept (${reached.size} reachable from the main thread); engine.wasm ${mb(primary)}, engine.deferred.wasm ${mb(deferredOut)} (from ${mb(full)})`,
  );
}

try {
  await main();
} finally {
  if (!process.env.BL_SPLIT_KEEP) rmSync(work, { recursive: true, force: true });
}
