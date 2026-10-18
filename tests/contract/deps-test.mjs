// Checks the dependency direction of the packages (docs: spec of the layout), without a build:
// - packages/core/src imports nothing from @browser-lite/* and no node: module
// - transport-wisp, ui and profile import @browser-lite/core only with `import type` /
//   `export type`, have it as an exact peerDependency and import no other @browser-lite package
// - packages/server/src imports only node: modules, its own dependencies and relative files
// - outside packages/core/src and engine/ no source touches the engine directly: no _bl_
//   exports, no Emscripten Module, no createBrowserLiteEngine, no __bl* globals
// - apps, examples and the core test host import packages only through their entry points
// Only source folders count (src/, the test host page); tests and dist are not checked.
//   node tests/contract/deps-test.mjs
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CODE = /\.(ts|tsx|js|mjs|cjs|html)$/;
const SCOPE = '@browser-lite/';

let failed = 0;
const check = (name, problems) => {
  console.log(`${problems.length ? 'FAIL' : 'ok  '} ${name}${problems.length ? `: ${problems.join('; ')}` : ''}`);
  if (problems.length)
    failed++;
};

function walk(dir) {
  if (!existsSync(dir))
    return [];
  const result = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== 'node_modules' && name !== 'dist')
        result.push(...walk(full));
    } else if (CODE.test(name))
      result.push(full);
  }
  return result;
}

const rel = (file) => path.relative(root, file).split(path.sep).join('/');
const read = (file) => readFileSync(file, 'utf8');
const json = (file) => JSON.parse(read(file));
const subdirs = (dir) => (existsSync(dir) ? readdirSync(dir).filter((name) => statSync(path.join(dir, name)).isDirectory()) : []);
// Comments do not count
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'\\])\/\/.*$/gm, '$1');

// Every module specifier with the kind of import: 'type' (import type / export type), 'value'
function imports(text) {
  const result = [];
  const code = stripComments(text);
  for (const match of code.matchAll(/\b(import|export)\s+(type\s+)?(?:[\w*{},\s$]*?\s+from\s+)?['"]([^'"]+)['"]/g))
    result.push({ specifier: match[3], type: !!match[2] });
  for (const match of code.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g))
    result.push({ specifier: match[1], type: false });
  return result;
}

const packageName = (specifier) => {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
};

const packagesDir = path.join(root, 'packages');
const packages = new Map();
for (const dir of subdirs(packagesDir)) {
  const file = path.join(packagesDir, dir, 'package.json');
  if (existsSync(file))
    packages.set(json(file).name, { dir: path.join(packagesDir, dir), manifest: json(file) });
}
const sources = (name) => walk(path.join(packages.get(name)?.dir ?? '/nonexistent', 'src'));

// ------------------------------------------------------------ core

const coreProblems = [];
for (const file of sources('@browser-lite/core')) {
  for (const { specifier } of imports(read(file))) {
    if (specifier.startsWith(SCOPE) || specifier.startsWith('node:'))
      coreProblems.push(`${rel(file)} imports ${specifier}`);
  }
}
check('packages/core/src imports no @browser-lite package and no node: module', coreProblems);

// ------------------------------------------------------------ peers of the core

const core = packages.get('@browser-lite/core');
for (const name of ['@browser-lite/transport-wisp', '@browser-lite/ui', '@browser-lite/profile']) {
  const entry = packages.get(name);
  if (!entry) {
    check(`${name} exists`, ['package missing']);
    continue;
  }
  const problems = [];
  for (const file of sources(name)) {
    for (const { specifier, type } of imports(read(file))) {
      if (packageName(specifier) === '@browser-lite/core' && (!type || specifier !== '@browser-lite/core'))
        problems.push(`${rel(file)}: ${specifier} without import type`);
      else if (specifier.startsWith(SCOPE) && packageName(specifier) !== '@browser-lite/core')
        problems.push(`${rel(file)} imports ${specifier}`);
    }
  }
  const peer = entry.manifest.peerDependencies?.['@browser-lite/core'];
  if (peer !== core?.manifest.version)
    problems.push(`peerDependencies @browser-lite/core is ${peer}, not exactly ${core?.manifest.version}`);
  if (entry.manifest.dependencies?.['@browser-lite/core'])
    problems.push('@browser-lite/core is a dependency, not only a peer');
  check(`${name} uses @browser-lite/core only as import type and exact peer`, problems);
}

// ------------------------------------------------------------ server

const server = packages.get('@browser-lite/server');
const serverDeps = new Set(Object.keys(server?.manifest.dependencies ?? {}));
const serverProblems = [];
for (const file of sources('@browser-lite/server')) {
  for (const { specifier } of imports(read(file))) {
    if (specifier.startsWith('node:') || specifier.startsWith('.'))
      continue;
    if (!serverDeps.has(packageName(specifier)))
      serverProblems.push(`${rel(file)} imports ${specifier}`);
  }
}
check('packages/server/src imports only node:, its dependencies and own files', serverProblems);

// ------------------------------------------------------------ engine access

const hostSources = [
  ...[...packages.keys()].filter((name) => name !== '@browser-lite/core').flatMap((name) => sources(name)),
  ...subdirs(path.join(root, 'apps')).flatMap((dir) => walk(path.join(root, 'apps', dir, 'src'))),
  ...subdirs(path.join(root, 'examples')).flatMap((dir) => walk(path.join(root, 'examples', dir, 'src'))),
  ...walk(path.join(root, 'tests', 'core', 'host')),
];
const FORBIDDEN = [
  [/\b_bl_\w+/, 'engine export'],
  [/(?<![\w.$])Module\s*(\.|\[)/, 'Emscripten Module'],
  [/\bcreateBrowserLiteEngine\b/, 'createBrowserLiteEngine'],
  [/\b__bl[A-Za-z]\w*/, '__bl global'],
];
const accessProblems = [];
for (const file of hostSources) {
  const text = stripComments(read(file));
  for (const [pattern, what] of FORBIDDEN) {
    const match = text.match(pattern);
    if (match)
      accessProblems.push(`${rel(file)}: ${what} (${match[0]})`);
  }
}
check('no engine access outside packages/core/src and engine/', accessProblems);

// ------------------------------------------------------------ entry points

const entryPoints = new Map();
for (const [name, { manifest }] of packages) {
  for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
    const file = typeof target === 'string' ? target : target.default;
    entryPoints.set(name + subpath.slice(1), path.posix.join('/packages', path.basename(packages.get(name).dir), file));
  }
}
const entryProblems = [];
const appSources = hostSources.filter((file) => !rel(file).startsWith('packages/'));
for (const file of appSources) {
  const text = read(file);
  for (const { specifier } of imports(text)) {
    if (specifier.startsWith(SCOPE) && !entryPoints.has(specifier))
      entryProblems.push(`${rel(file)} imports ${specifier}, no entry point`);
    if (/(^|\/)packages\//.test(specifier))
      entryProblems.push(`${rel(file)} imports the file ${specifier}`);
  }
  // Import maps of pages point at the entry files of the packages
  for (const map of text.matchAll(/<script type="importmap">([\s\S]*?)<\/script>/g)) {
    for (const [specifier, target] of Object.entries(JSON.parse(map[1]).imports ?? {})) {
      if (specifier.startsWith(SCOPE) && entryPoints.get(specifier) !== target)
        entryProblems.push(`${rel(file)} maps ${specifier} to ${target}, not ${entryPoints.get(specifier)}`);
    }
  }
}
check('apps, examples and the test host use only package entry points', entryProblems);

if (failed) {
  console.log(`${failed} check(s) failed`);
  process.exit(1);
}
console.log('Dependency direction ok');
