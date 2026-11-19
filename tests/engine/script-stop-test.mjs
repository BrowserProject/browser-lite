// A script the user's navigation stops ends alone: promise reactions of every view still run
// afterwards (patch 0165). The page calls into guest WebAssembly whose import runs long, once from
// a promise reaction and once from a FinalizationRegistry callback (like the glue of wasm-bindgen,
// whose callback frees the WebAssembly side, as hCaptcha's hsw.js does). The host leaves the page
// (bl_load_url) while the import runs and the engine stops the script. Then a view with a chain of
// promise reactions (each digest starts the next) has to go on, and a new view's Promise.then has
// to run. Before, the stopped microtask checkpoint left its TerminationException pending: the
// next checkpoints dropped their microtasks (the chain ended), and JSC's DeferredWorkTimer (the
// registry's cleanup) took it as the end of the VM and forbade execution: no microtask of any
// view ran again.
//
//   node tests/engine/script-stop-test.mjs [engine-dir]
import { code, sec, str, wasm } from '../fixtures/wasm-bytes.mjs';
import { enginePath as resolveEngine, runEngine } from './engine-node.mjs';

const enginePath = resolveEngine(process.argv[2]);

// (import "m" "f" (func)) (func (export "run") call 0)
const bytes = wasm(
  sec(1, [0x60, 0, 0]),
  sec(2, [...str('m'), ...str('f'), 0, 0]),
  sec(3, [0]),
  sec(7, [...str('run'), 0, 1]),
  sec(10, code(0x10, 0)),
);

// The import runs up to 20 s and makes garbage and dead objects of the registry: once it stops, a
// cleanup of the registry is due
const page = (round) => `<!DOCTYPE html><script>
let garbage = [];
const busy = () => {
  if (window.ran) return;
  window.ran = true;
  console.log('STOP-TEST busy');
  const end = Date.now() + 20000;
  for (let i = 0; Date.now() < end; i++) {
    garbage.push({ list: [i] });
    if (garbage.length > 100000) garbage = [];
    if (i % 1000 === 0) registry.register({ i }, i);
  }
  console.log('STOP-TEST not stopped');
};
WebAssembly.instantiate(new Uint8Array([${bytes}]), { m: { f: busy } }).then(({ instance }) => {
  const reaction = '${round}' === 'reaction';
  window.registry = new FinalizationRegistry(() => reaction || instance.exports.run());
  for (let i = 0; i < 1000; i++) registry.register({ i }, i);
  if (reaction) Promise.resolve().then(() => instance.exports.run());
  else setInterval(() => {
    for (let i = 0; i < 20000; i++) garbage.push({ i, list: [i] });
    if (garbage.length > 200000) garbage = [];
  }, 20);
});
</script>`;

const failed = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ` (${detail})`}`);
  if (!ok) failed.push(name);
};

const timeout = setTimeout(() => {
  console.error('ERROR: timeout (150s)');
  process.exit(1);
}, 150000);

const lines = [];
const events = [];
const waiters = [];
// Resolves with true once predicate() holds (checked on every console line and event), false
// after ms
const waitFor = (predicate, ms) =>
  new Promise((resolve) => {
    const test = () => {
      if (!predicate()) return false;
      waiters.splice(waiters.indexOf(test), 1);
      resolve(true);
      return true;
    };
    waiters.push(test);
    if (test()) return;
    setTimeout(() => {
      if (waiters.includes(test)) {
        waiters.splice(waiters.indexOf(test), 1);
        resolve(false);
      }
    }, ms);
  });
const notify = () => {
  for (const waiter of [...waiters]) waiter();
};
const logged = (line) => lines.includes(line);
// Failed navigations of view 1
const loadErrors = () =>
  events.filter((event) => event.viewId === 1 && event.type === 'error').length;

let engine = null;
let nextView = 2;
// A new view whose script logs from a timer and from a promise reaction
const newView = async () => {
  const id = nextView++;
  engine._bl_create_view(id, 400, 300, 1);
  engine._bl_load_html(
    id,
    engine.stringToNewUTF8(
      `<script>setTimeout(() => console.log('STOP-TEST timer ${id}'), 10); Promise.resolve().then(() => console.log('STOP-TEST microtask ${id}'))</script>`,
    ),
    engine.stringToNewUTF8(`https://view${id}.test/`),
  );
  const timer = await waitFor(() => logged(`STOP-TEST timer ${id}`), 15000);
  return { timer, microtask: logged(`STOP-TEST microtask ${id}`) };
};

let ready;
const started = new Promise((resolve) => {
  ready = resolve;
});
runEngine({
  enginePath,
  html: '<!DOCTYPE html>start',
  url: 'https://start.test/',
  width: 400,
  height: 300,
  onConsole(message) {
    lines.push(message);
    notify();
  },
  onEvent({ viewId, type }) {
    events.push({ viewId, type });
    notify();
  },
  onLoad(event) {
    engine = event.engine;
    ready();
  },
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
await started;
const before = await newView();
check('a new view runs its timer and promise reaction', before.timer && before.microtask);

// A view whose promise reactions keep running: each digest settles in a task of the engine and
// its reaction starts the next one
const chainView = nextView++;
engine._bl_create_view(chainView, 400, 300, 1);
engine._bl_load_html(
  chainView,
  engine.stringToNewUTF8(`<script>
let steps = 0;
const step = () => crypto.subtle.digest('SHA-256', new Uint8Array(64)).then(() => { steps++; step(); });
step();
setInterval(() => console.log('STOP-TEST steps ' + steps), 250);
</script>`),
  engine.stringToNewUTF8('https://chain.test/'),
);
const chainSteps = () => {
  const line = lines.findLast((text) => text.startsWith('STOP-TEST steps '));
  return line ? Number(line.slice(16)) : -1;
};
// Whether the chain advances within ms
const chainAdvances = async (ms) => {
  const start = chainSteps();
  return waitFor(() => chainSteps() > start, ms);
};
await waitFor(() => chainSteps() >= 0, 10000);
check('promise reactions of another view run', await chainAdvances(5000));

for (const round of ['reaction', 'finalization']) {
  // Console lines of this round
  const since = lines.length;
  const loggedNow = (prefix) => lines.slice(since).some((line) => line.startsWith(prefix));
  engine._bl_load_html(
    1,
    engine.stringToNewUTF8(page(round)),
    engine.stringToNewUTF8(`https://${round}.test/`),
  );
  const busy = await waitFor(() => loggedNow('STOP-TEST busy'), 60000);
  check(`${round}: the import runs`, busy);
  if (!busy) continue;
  // Long enough for a few GCs
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const failedLoads = loadErrors();
  engine._bl_load_url(1, engine.stringToNewUTF8(`https://left-${round}.test/`));
  check(
    `${round}: leaving the page stops the script`,
    await waitFor(() => loggedNow('Script stopped: the user left the page'), 10000),
  );
  // Without a transport the navigation fails; until then the new view would wait for it (#394)
  await waitFor(() => loadErrors() > failedLoads, 10000);
  check(`${round}: promise reactions of another view still run`, await chainAdvances(5000));
  const after = await newView();
  check(`${round}: a new view runs its timer`, after.timer);
  check(`${round}: a new view runs its promise reaction`, after.microtask);
  check(`${round}: the import did not run to its end`, !loggedNow('STOP-TEST not stopped'));
}

clearTimeout(timeout);
if (failed.length) {
  console.log(`ERROR: ${failed.length} checks failed: ${failed.join(', ')}`);
  process.exit(1);
}
console.log('All checks passed');
process.exit(0);
