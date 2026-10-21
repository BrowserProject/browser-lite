// Checks engine/abi.json against the sources, without a build:
// - every EMSCRIPTEN_KEEPALIVE bl_ function of engine/src and engine/patches is listed with
//   the right prefix (bl_ public, bl__ internal) and the same signature
// - every event type sent with notifyHost/notifyCapture is listed
// - getenv only in engine/src/EngineConfig.cpp, every BL_* read anywhere is listed in env
// - every Module field the engine reads or sets is a listed module hook (or engine internal)
// - features, host calls and close reasons match EngineConfig.cpp, WebPlatformExtras.cpp,
//   Sockets.cpp and sockets.js
// - packages/core/src only calls public exports, ENGINE_EXPORTS of packages/core/src/engine.ts
//   lists exactly the public exports (minus NOT_USED_BY_CORE) and exactly the calls of the core
// - abiVersion is the same in abi.json, engine/js/engine-pre.js and packages/core/src/engine.ts
//   node tests/contract/abi-test.mjs
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const abi = JSON.parse(readFileSync(path.join(root, 'engine', 'abi.json'), 'utf8'));

let failed = 0;
const check = (name, ok, info = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !info ? '' : `: ${info}`}`);
  if (!ok) failed++;
};

function walk(dir, filter) {
  const result = [];
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return result;
  }
  for (const name of names) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) result.push(...walk(full, filter));
    else if (filter(full)) result.push(full);
  }
  return result;
}

const rel = (file) => path.relative(root, file).split(path.sep).join('/');
const read = (file) => readFileSync(file, 'utf8');
// Only the added lines of a patch are our code
const patchText = (file) =>
  read(file)
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1))
    .join('\n');
// Comments do not count as uses
const stripComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'\\])\/\/.*$/gm, '$1');

const sources = walk(path.join(root, 'engine', 'src'), (f) => /\.(cpp|h)$/.test(f)).map((f) => ({
  file: rel(f),
  text: stripComments(read(f)),
}));
const patches = walk(path.join(root, 'engine', 'patches'), (f) => f.endsWith('.patch')).map(
  (f) => ({ file: rel(f), text: stripComments(patchText(f)) }),
);
const scripts = walk(path.join(root, 'engine', 'js'), (f) => f.endsWith('.js')).map((f) => ({
  file: rel(f),
  text: stripComments(read(f)),
}));
const engineCode = [...sources, ...patches];
const unique = (list) => [...new Set(list)];
const missing = (list, known) => list.filter((name) => !known.has(name));
const normalize = (text) =>
  text
    .replace(/\s+/g, ' ')
    .replace(/\s*([*&,()])\s*/g, '$1')
    .trim();

// ------------------------------------------------------------ Exports

const keepalive = new Map();
for (const { file, text } of engineCode) {
  for (const match of text.matchAll(
    /EMSCRIPTEN_KEEPALIVE\s+([\w:*\s]+?)\s*\b(bl_\w+)\s*\(([^)]*)\)/g,
  ))
    keepalive.set(match[2], { returns: match[1].trim(), args: match[3], file });
}
const exports = new Map(abi.exports.map((entry) => [entry.name, entry]));
const internal = new Map(abi.internalExports.map((entry) => [entry.name, entry]));
const names = [...keepalive.keys()];
check(
  'every public bl_ export is listed in exports',
  missing(
    names.filter((n) => !n.startsWith('bl__')),
    exports,
  ).length === 0,
  missing(
    names.filter((n) => !n.startsWith('bl__')),
    exports,
  ).join(', '),
);
check(
  'every internal bl__ export is listed in internalExports',
  missing(
    names.filter((n) => n.startsWith('bl__')),
    internal,
  ).length === 0,
  missing(
    names.filter((n) => n.startsWith('bl__')),
    internal,
  ).join(', '),
);
check(
  'exports only hold bl_ names, internalExports only bl__ names',
  [...exports.keys()].every((n) => /^bl_[a-z]/.test(n)) &&
    [...internal.keys()].every((n) => n.startsWith('bl__')),
);
const keepaliveNames = new Set(names);
check(
  'every listed export exists in the sources',
  missing([...exports.keys(), ...internal.keys()], keepaliveNames).length === 0,
  missing([...exports.keys(), ...internal.keys()], keepaliveNames).join(', '),
);
const wrongSignature = abi.exports
  .filter((entry) => {
    const source = keepalive.get(entry.name);
    return (
      source &&
      (normalize(source.args) !== normalize(entry.args) ||
        normalize(source.returns) !== normalize(entry.returns))
    );
  })
  .map((entry) => `${entry.name}(${keepalive.get(entry.name).args})`);
check(
  'export signatures match the sources',
  wrongSignature.length === 0,
  wrongSignature.join('; '),
);
check(
  'every export is documented',
  abi.exports.every((entry) => entry.doc) &&
    abi.internalExports.every((entry) => entry.doc && entry.caller),
);

// Internal exports are called by the engine only
const internalCallers = [...internal.keys()].filter((name) => {
  const pattern = new RegExp(`\\b_?${name}\\b`);
  return ![...scripts, ...engineCode].some(({ text }) =>
    pattern.test(text.replace(new RegExp(`EMSCRIPTEN_KEEPALIVE[^(]*\\b${name}\\s*\\(`, 'g'), '')),
  );
});
check(
  'every internal export is called inside the engine',
  internalCallers.length === 0,
  internalCallers.join(', '),
);

// ------------------------------------------------------------ Events

const sent = new Set();
for (const { text } of engineCode) {
  for (const match of text.matchAll(/notifyHost\([^,()]+(?:\([^()]*\))?,\s*"([a-z-]+)"/g))
    sent.add(match[1]);
  for (const match of text.matchAll(/notifyCapture\("([a-z-]+)"_s/g)) sent.add(match[1]);
}
const events = new Map(abi.events.map((entry) => [entry.type, entry]));
check(
  'every notifyHost type is listed in events',
  missing([...sent], events).length === 0,
  missing([...sent], events).join(', '),
);
check(
  'every listed event is sent by the engine',
  missing([...events.keys()], sent).length === 0,
  missing([...events.keys()], sent).join(', '),
);
check(
  'every event has a scope view or global',
  abi.events.every((entry) => entry.scope === 'view' || entry.scope === 'global'),
);

// ------------------------------------------------------------ Environment

const getenvOutside = sources
  .filter(({ file, text }) => file !== 'engine/src/EngineConfig.cpp' && /\bgetenv\s*\(/.test(text))
  .map(({ file }) => file);
check(
  'getenv in engine/src only in EngineConfig.cpp',
  getenvOutside.length === 0,
  getenvOutside.join(', '),
);
const env = new Map(abi.env.map((entry) => [entry.name, entry]));
const configText = sources.find(({ file }) => file === 'engine/src/EngineConfig.cpp')?.text ?? '';
const configNames = unique(
  [...configText.matchAll(/(?:getenv|value|flag|number)\("(BL_\w+)"/g)].map((m) => m[1]),
);
check(
  'every value read by EngineConfig.cpp is listed in env',
  missing(configNames, env).length === 0,
  missing(configNames, env).join(', '),
);
const notRead = abi.env
  .filter(
    (entry) =>
      entry.readBy.includes('engine/src/EngineConfig.cpp') && !configNames.includes(entry.name),
  )
  .map((entry) => entry.name);
check('env entries of EngineConfig.cpp are read there', notRead.length === 0, notRead.join(', '));
const patchReads = [];
for (const { file, text } of patches) {
  for (const match of text.matchAll(/getenv\("(BL_\w+)"\)/g)) {
    if (!env.get(match[1])?.readBy.includes(file)) patchReads.push(`${match[1]} (${file})`);
  }
}
check(
  'every getenv of a patch is listed with the patch in readBy',
  patchReads.length === 0,
  patchReads.join(', '),
);
check(
  'every env entry has type, default, class and doc',
  abi.env.every(
    (entry) =>
      entry.type &&
      entry.default !== undefined &&
      ['core-owned', 'debug-only', 'expert'].includes(entry.class) &&
      entry.doc,
  ),
);

// ------------------------------------------------------------ Module hooks

// Fields the engine keeps on Module for itself, and the Emscripten runtime
const engineInternal = new Set([
  'blCanvases',
  'blTaskChannel',
  'blGpuCanvas',
  'blGpuRestoreForTesting',
  'ENV',
  'HEAPU8',
  'HEAPF32',
  'HEAP32',
]);
const used = new Set();
for (const { text } of [...engineCode, ...scripts]) {
  for (const match of text.matchAll(/(?<![\w.])Module(?:\.|\[')(\w+)/g)) {
    if (!match[1].startsWith('_') && !engineInternal.has(match[1])) used.add(match[1]);
  }
}
const hooks = new Map(abi.moduleHooks.map((entry) => [entry.name, entry]));
check(
  'every Module field of the engine is a listed module hook',
  missing([...used], hooks).length === 0,
  missing([...used], hooks).join(', '),
);
const emscriptenHooks = new Set([
  'locateFile',
  'preRun',
  'print',
  'printErr',
  'instantiateWasm',
  'getPreloadedPackage',
]);
const unusedHooks = [...hooks.keys()].filter(
  (name) => !used.has(name) && !emscriptenHooks.has(name),
);
check(
  'every listed module hook is used by the engine',
  unusedHooks.length === 0,
  unusedHooks.join(', '),
);
const assigned = new Set();
for (const { text } of scripts) {
  for (const match of text.matchAll(/(?<![\w.])Module(?:\.|\[')(\w+)'?\]?\s*=(?!=|\s*null)/g))
    assigned.add(match[1]);
}
const wrongSide = abi.moduleHooks
  .filter((entry) => (entry.setBy === 'engine') !== assigned.has(entry.name))
  .map((entry) => `${entry.name} (${entry.setBy})`);
check(
  'setBy engine exactly for the fields engine/js assigns',
  wrongSide.length === 0,
  wrongSide.join(', '),
);

// ------------------------------------------------------------ Features, host calls, close reasons

const featureNames = [...configText.matchAll(/\{\s*"([a-z-]+)",\s*Feature::(\w+)\s*\}/g)].map(
  (m) => ({ name: m[1], id: m[2] }),
);
check(
  'features match EngineConfig.cpp',
  JSON.stringify(featureNames.map((f) => f.name)) ===
    JSON.stringify(abi.features.map((f) => f.name)),
  featureNames.map((f) => f.name).join(','),
);
const featureById = new Map(featureNames.map((f) => [f.id, f.name]));
const extras = sources.find(({ file }) => file === 'engine/src/WebPlatformExtras.cpp')?.text ?? '';
const allowed = {};
for (const match of extras.matchAll(/\{\s*"([a-z-]+)"_s,\s*Feature::(\w+)\s*\}/g))
  (allowed[featureById.get(match[2])] ??= []).push(match[1]);
const sortedCalls = (map) =>
  JSON.stringify(
    Object.keys(map)
      .sort()
      .map((key) => [key, [...map[key]].sort()]),
  );
check(
  'hostCalls match the allowlist of WebPlatformExtras.cpp',
  sortedCalls(allowed) === sortedCalls(abi.hostCalls),
  sortedCalls(allowed),
);
const socketsJS = scripts.find(({ file }) => file === 'engine/js/sockets.js')?.text ?? '';
const jsReasons = JSON.parse(
  (socketsJS.match(/blCloseReasons = (\[[^\]]*\])/)?.[1] ?? '[]').replace(/'/g, '"'),
);
check(
  'closeReasons match engine/js/sockets.js',
  JSON.stringify(jsReasons) === JSON.stringify(abi.closeReasons),
  jsReasons.join(','),
);
const socketsCpp = sources.find(({ file }) => file === 'engine/src/Sockets.cpp')?.text ?? '';
const enumValues = (socketsCpp.match(/enum class CloseReason : int \{([^}]*)\}/)?.[1] ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const camel = (name) => name.replace(/(^|-)([a-z])/g, (_, __, c) => c.toUpperCase());
check(
  'closeReasons match the enum of Sockets.cpp',
  JSON.stringify(enumValues) === JSON.stringify(abi.closeReasons.map(camel)),
  enumValues.join(','),
);

// ------------------------------------------------------------ Host side

// Public exports the core does not call (none today; each entry needs a reason)
const NOT_USED_BY_CORE = [];
const core = walk(path.join(root, 'packages', 'core', 'src'), (f) => /\.(ts|js|mjs)$/.test(f));
const coreCalls = unique(
  core.flatMap((file) => [...read(file).matchAll(/\b_(bl_\w+)/g)].map((m) => m[1])),
);
check(
  'packages/core/src only calls public exports',
  coreCalls.filter((name) => !exports.has(name)).length === 0,
  coreCalls.filter((name) => !exports.has(name)).join(', '),
);
const engineTS = read(path.join(root, 'packages', 'core', 'src', 'engine.ts'));
const declared = [
  ...(engineTS.match(/const ENGINE_EXPORTS = \[([\s\S]*?)\n\] as const;/)?.[1] ?? '').matchAll(
    /'_(bl_\w+)'/g,
  ),
].map((m) => m[1]);
const sameSet = (a, b) =>
  JSON.stringify([...new Set(a)].sort()) === JSON.stringify([...new Set(b)].sort());
const expected = [...exports.keys()].filter((name) => !NOT_USED_BY_CORE.includes(name));
check(
  'ENGINE_EXPORTS lists the public exports minus NOT_USED_BY_CORE',
  sameSet(declared, expected),
  `missing: ${missing(expected, new Set(declared)).join(', ')}; extra: ${missing(declared, new Set(expected)).join(', ')}`,
);
const called = new Set(
  core.flatMap((file) => [...read(file).matchAll(/\._(bl_\w+)\b/g)].map((m) => m[1])),
);
check(
  'every export in ENGINE_EXPORTS is called by the core',
  missing(declared, called).length === 0,
  missing(declared, called).join(', '),
);
check(
  'NOT_USED_BY_CORE only names public exports',
  NOT_USED_BY_CORE.every((name) => exports.has(name)),
);
check(
  'bl_crash_for_testing stays a public export used by the core',
  exports.has('bl_crash_for_testing') && declared.includes('bl_crash_for_testing'),
);

// ------------------------------------------------------------ ABI version

const preJS = read(path.join(root, 'engine', 'js', 'engine-pre.js'));
const engineVersion = Number(preJS.match(/Module\.blAbiVersion = (\d+);/)?.[1]);
const coreVersion = Number(engineTS.match(/export const ENGINE_ABI_VERSION = (\d+);/)?.[1]);
check('abi.json has an integer abiVersion', Number.isInteger(abi.abiVersion) && abi.abiVersion > 0);
check(
  'engine-pre.js announces the abiVersion of abi.json',
  engineVersion === abi.abiVersion,
  String(engineVersion),
);
check(
  'the core expects the abiVersion of abi.json',
  coreVersion === abi.abiVersion,
  String(coreVersion),
);

if (failed) {
  console.log(`${failed} check(s) failed`);
  process.exit(1);
}
console.log('engine/abi.json matches the sources');
