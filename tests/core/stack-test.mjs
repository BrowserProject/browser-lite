// Deep recursion through C++ (patch 0075, engine/jit/MachineStack.cpp): chains of proxies, getters,
// toString and nested objects for JSON.stringify fill the browser's machine stack long before
// JSC's own limit; the page gets a RangeError it can catch like in Chromium, the engine keeps
// running. A one-character replace on a deep rope string and JSON.parse of deep arrays give the
// same result as in Chromium (#368). Shallow chains still work.
//
//   node tests/core/stack-test.mjs [engine-dir]
import {
  check,
  collect,
  finish,
  launch,
  openHost,
  serve,
  startStack,
  timeLimit,
} from '../lib/index.mjs';

timeLimit();

// Runs in the engine page: one line "name:result" per case
function stackCases() {
  const proxy = (n) => {
    let p = {};
    for (let i = 0; i < n; i++) p = new Proxy(p, {});
    return p.x;
  };
  const getter = (n) => {
    const objects = [];
    for (let i = 0; i < n; i++) {
      const o = {};
      Object.defineProperty(o, 'v', { get: () => (i + 1 < n ? objects[i + 1].v : 0) });
      objects.push(o);
    }
    return objects[0].v;
  };
  const toString = (n) => {
    let o = {};
    for (let i = 0; i < n; i++) {
      const previous = o;
      o = { toString: () => String(previous) };
    }
    return String(o).length;
  };
  const stringify = (n) => {
    const root = {};
    let o = root;
    for (let i = 0; i < n; i++) o = o.a = {};
    return JSON.stringify(root).length;
  };
  // A rope string of n appended characters; a one-character replace walks it recursively
  const ropeReplace = (n, search) => {
    let s = 'b';
    for (let i = 0; i < n; i++) s = s + String.fromCharCode(97 + (i % 20));
    const r = s.replace(search, 'Y');
    return `${r.length}${r.slice(0, 2)}${r.slice(-2)}`;
  };
  const parse = (n) => {
    let a = JSON.parse('['.repeat(n) + ']'.repeat(n));
    let depth = 0;
    while (a.length) {
      a = a[0];
      depth++;
    }
    return depth;
  };
  const out = [];
  const run = (name, fn) => {
    try {
      out.push(`${name}:${JSON.stringify(fn())}`);
    } catch (e) {
      out.push(`${name}:${e.name}`);
    }
  };
  run('proxy100', () => proxy(100));
  run('getter100', () => getter(100));
  run('toString100', () => toString(100));
  run('stringify1000', () => stringify(1000));
  run('ropeReplace100', () => ropeReplace(100, 'c'));
  run('parse1000', () => parse(1000));
  run('proxyDeep', () => proxy(200000));
  run('getterDeep', () => getter(100000));
  run('toStringDeep', () => toString(100000));
  run('stringifyDeep', () => stringify(300000));
  run('ropeReplaceDeep', () => ropeReplace(100000, 'z'));
  run('ropeReplaceDeepFound', () => ropeReplace(100000, 'b'));
  run('parseDeep', () => parse(100000));
  // The same again: the checks still hold after a RangeError
  run('getterAgain', () => getter(100000));
  run('after', () => getter(100));
  return out.join(' ');
}

const PAGE = `<!doctype html><title>Stack</title><script>
${stackCases.toString()}
console.log('RESULT cases=' + encodeURIComponent(stackCases()));
setTimeout(() => console.log('RESULT alive=' + [1, 2, 3].map((x) => x * 2).join()), 100);
</script>`;
const { url: siteURL } = await serve((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' }).end(PAGE);
});

const stack = await startStack();
const browser = await launch();
const page = await browser.newPage();
const results = collect(page);
await openHost(page, stack.app({ url: siteURL }));
const raw = await results.wait('cases');
const cases = Object.fromEntries(
  (raw ? decodeURIComponent(raw).split(' ') : []).map((line) => line.split(':')),
);
// Shallow cases as in node; deep ones throw (V8's JSON.stringify does not recurse, JSC's does)
const expected = Object.fromEntries(
  stackCases()
    .split(' ')
    .map((line) => line.split(':')),
);
check('all cases ran', raw !== null, raw ?? 'no result');
for (const [name, value] of Object.entries(expected)) {
  const ok =
    name === 'stringifyDeep' ? [value, 'RangeError'].includes(cases[name]) : cases[name] === value;
  check(`${name}: ${value}`, ok, cases[name]);
}
check('the page keeps running', (await results.wait('alive')) === '2,4,6');
await browser.close();
finish();
