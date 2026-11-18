// Test pages in the engine (node, render.mjs), one engine process each:
//   basic.html     frame checked by check-basic.mjs (box, circle, text, JavaScript)
//   crypto.html    WebCrypto (OpenSSL in WASM), CryptoKeys through structuredClone, postMessage, a
//                  worker and IndexedDB (CryptoKeys.cpp)
//   stack.html     stack limit after a VM trap (recursion after a GC request)
//   limits.html    deep DOM, long strings, memory until the end
//   hang.html      watchdog: an endless loop the host waits for is stopped, the engine keeps
//                  running (BL_SCRIPT_TIMEOUT=2)
//   bridges.html   features and host bridges: no __bl globals, disabled features missing (none, all)
//   lazy.html      ICU data and fonts loaded on first use (lazy/ next to the engine)
//   svg-use.html   load events of <use> elements of an external sprite (patch 0051)
//   font-stacks.html  unknown families skipped in a stack, Apple and system names mapped
//   computed-style.html  getComputedStyle() without a renderer: selectors match exactly (patch 0069)
//   localized-strings.html  UI strings with placeholders filled: validation messages (patch 0076)
//   absent-properties.html  missing properties of module namespaces and named properties are not
//                  cached as absent (patch 0085), with the JIT and in the interpreter alone
//   percent-heights.html  boxes with percentage heights are laid out again only when what their
//                  percentages resolve against changed (patch 0098): same geometry as a fresh
//                  layout, a small change next to many of them costs a fraction of a full relayout
//   column-balancing.html  blocks inside one column keep their layout in the balancing passes of a
//                  multicol (patch 0118): same geometry as a fresh layout and as a multicol where
//                  nothing is kept, a relayout of balanced columns costs about as much as without
//   cssom-rules.html  a rule insertRule() adds or deleteRule() removes restyles only the elements
//                  it may match (patch 0124) and an inserted one goes into the built rule set
//                  (patch 0158): same computed style as a fresh style of the tree with a new rule
//                  set, also in a frame whose media queries change, an inserted rule next to 4000
//                  elements costs a fraction of a full restyle and next to 5000 more rules about
//                  as much as without them
//   compression.html  CompressionStream and DecompressionStream take buffers of another realm
//                  (patch 0110) and still reject chunks that are no BufferSource
//   time-origin.html  performance.timeOrigin reads the same every time in a page, a frame and a
//                  worker, next to Date.now() (patch 0134)
//   intersection-observer.html  observers compute again only after something moved, sized or
//                  clipped a target (patch 0137): every change gives what a fresh observer reports,
//                  a frame without a change next to 3000 targets costs a fraction of one with a new
//                  target
//   storage-quota.html  localStorage and sessionStorage hold 5 MiB of UTF-16 code units whatever
//                  the width of the characters (patch 0140), like Chrome and Firefox
//   word-boundaries.html  moving and deleting by word, the word of a double click and
//                  Intl.Segmenter stop where Chrome stops (patch 0145, tools/icu-word-rules.cpp):
//                  punctuation ends a word, a full stop or colon between letters separates them
//   font-loads.html  a web font that loads or a font face that is added gives the styles new fonts
//                  without restyling the document (patch 0148): same computed style and geometry
//                  as a fresh style, also for font metric units, pseudo-elements and shadow trees,
//                  an added face next to 2000 elements costs a fraction of a full restyle
//   transform-presence.html  a transform that comes or goes on a positioned box recomputes only the
//                  overflow of its ancestors (patch 0153): same geometry, scroll sizes and layer
//                  on top as a fresh layout, also for out of flow descendants, floats, inline
//                  blocks and table cells; toggling a slide's transform costs about as much as
//                  changing it
//   replaced-percent-heights.html  an image with a percentage height is a percentage height
//                  descendant only of the containers its height depends on (patch 0154): same
//                  geometry as a fresh layout, a margin that changes on one slide next to many
//                  cards with an aspect ratio picture costs a fraction of a full relayout
//   image-load-events.html  a pass of the shared sender of image load events ends after its time
//                  budget (patch 0159): a timer that is due runs between expensive load
//                  listeners, every event still comes in order, the window load after them
//   select-styles.html  frame checked by check-select-styles.mjs: a select whose background or
//                  border the page sets shows them with the arrow in its text color inside the
//                  border like in Chrome, one without them keeps the native button (patch 0157)
//   form-controls.html  controls without author styles have Chrome's metrics (patch 0161): 13.333px
//                  font, text field, button and select as tall as in Chrome with the same font,
//                  13 px checkbox and radio; check-form-controls.mjs: their borders reach 3:1
//                  contrast on white
//   cookies.html   a host that is a public suffix (github.io, like httpbin.org) keeps its host-only
//                  cookies, a Domain of a public suffix above the host is still rejected (patch 0129)
//
//   node tests/engine/pages-test.mjs [engine-dir]
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const here = import.meta.dirname;
const root = path.resolve(here, '..', '..');
const engine = path.resolve(process.argv[2] || path.join(root, 'build', 'webcore', 'bin'));
const out = path.join(root, 'build', 'engine-pages');
mkdirSync(out, { recursive: true });

const CASES = [
  { name: 'basic', size: [800, 600], check: 'check-basic.mjs' },
  { name: 'crypto', wait: 'CRYPTO done' },
  { name: 'stack', wait: 'STACK done' },
  { name: 'limits', wait: 'LIMITS done' },
  { name: 'hang', wait: 'HANG done', env: { BL_SCRIPT_TIMEOUT: '2' } },
  { name: 'lazy', wait: 'LAZY done' },
  { name: 'svg-use', size: [400, 40], wait: 'SVGUSE done' },
  { name: 'font-stacks', wait: 'FONTS done' },
  { name: 'computed-style', wait: 'COMPUTED done' },
  { name: 'localized-strings', wait: 'L10N done' },
  { name: 'absent-properties', wait: 'ABSENT done' },
  { name: 'percent-heights', size: [1000, 700], wait: 'PERCENT done' },
  { name: 'column-balancing', size: [1000, 700], wait: 'COLUMNS done' },
  { name: 'compression', wait: 'COMPRESSION done' },
  { name: 'cssom-rules', size: [800, 600], wait: 'CSSOM done' },
  { name: 'time-origin', wait: 'TIMEORIGIN done' },
  { name: 'intersection-observer', size: [800, 600], wait: 'INTERSECTION done' },
  { name: 'storage-quota', wait: 'QUOTA done', env: { RENDER_URL: 'https://example.com/' } },
  { name: 'word-boundaries', size: [800, 600], wait: 'WORDS done' },
  { name: 'font-loads', size: [800, 600], wait: 'FONTLOADS done' },
  { name: 'transform-presence', size: [800, 600], wait: 'TRANSFORM done' },
  { name: 'replaced-percent-heights', size: [1280, 800], wait: 'REPLACED done' },
  { name: 'image-load-events', wait: 'IMGLOAD done' },
  { name: 'select-styles', size: [400, 220], check: 'check-select-styles.mjs' },
  {
    name: 'form-controls',
    size: [300, 200],
    wait: 'CONTROLS done',
    check: 'check-form-controls.mjs',
  },
  {
    name: 'cookies',
    label: 'cookies (public suffix host)',
    wait: 'COOKIES done',
    env: { RENDER_URL: 'https://github.io/test/' },
  },
  {
    name: 'cookies',
    label: 'cookies (below a public suffix)',
    wait: 'COOKIES done',
    env: { RENDER_URL: 'https://user.github.io/test/' },
  },
  {
    name: 'absent-properties',
    label: 'absent-properties (interpreter)',
    wait: 'ABSENT done',
    env: { BL_JIT: '0' },
  },
  {
    name: 'bridges',
    label: 'bridges (no features)',
    wait: 'BRIDGES done',
    env: { BL_FEATURES: '', RENDER_URL: 'file:///test/?features=none' },
  },
  {
    name: 'bridges',
    label: 'bridges (all features)',
    wait: 'BRIDGES done',
    env: { RENDER_URL: 'file:///test/?features=all' },
  },
];

let failed = 0;
for (const { name, label = name, size = [200, 200], wait, env = {}, check } of CASES) {
  const ppm = path.join(out, `${label.replace(/\W+/g, '-')}.ppm`);
  const run = spawnSync(
    process.execPath,
    [
      path.join(here, 'render.mjs'),
      engine,
      path.join(here, 'pages', `${name}.html`),
      ppm,
      ...size.map(String),
    ],
    {
      env: { ...process.env, ...(wait ? { RENDER_WAIT_FOR: wait } : {}), ...env },
      encoding: 'utf8',
      maxBuffer: 64 << 20,
    },
  );
  const output = `${run.stdout}${run.stderr}`;
  let ok = run.status === 0 && (!wait || output.includes(`${wait}=ok`));
  let info = wait
    ? (output.match(new RegExp(`${wait}=\\S*`))?.[0] ?? `exit ${run.status}`)
    : `exit ${run.status}`;
  if (ok && check) {
    const frame = spawnSync(process.execPath, [path.join(here, check), ppm], {
      encoding: 'utf8',
    });
    process.stdout.write(frame.stdout.replace(/^/gm, '     '));
    ok = frame.status === 0;
    info = ok ? 'frame ok' : 'frame differs';
  }
  if (!ok) process.stdout.write(output.split('\n').slice(-40).join('\n'));
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label} ${info}`);
  if (!ok) failed++;
}
console.log(failed ? `${failed} check(s) failed` : 'All checks ok');
process.exit(failed ? 1 : 0);
