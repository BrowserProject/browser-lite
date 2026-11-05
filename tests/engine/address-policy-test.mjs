// Policy container of an address typed by the user, in node without a browser. A data: or
// about: document a page navigates to inherits the page's Content-Security-Policy (HTML spec);
// one typed into the address bar comes from the browser, not from the page, and starts with
// an empty policy like in Chrome.
//
//   node tests/engine/address-policy-test.mjs [engine-dir]
import { enginePath as resolveEngine, runEngine } from './engine-node.mjs';

const enginePath = resolveEngine(process.argv[2]);
process.env.BL_TEST_HOOKS = '1';

const failed = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ` (${detail})`}`);
  if (!ok) failed.push(name);
};

const timeout = setTimeout(() => {
  console.error('ERROR: timeout (120s)');
  process.exit(1);
}, 120000);

const events = [];
const waiters = [];
const consoleLines = [];
const evalResults = [];
const notify = () => {
  for (const waiter of [...waiters]) waiter();
};
const waitFor = (predicate) =>
  new Promise((resolve) => {
    const test = () => {
      const value = predicate();
      if (!value) return;
      waiters.splice(waiters.indexOf(test), 1);
      resolve(value);
    };
    waiters.push(test);
    test();
  });
const loads = () => events.filter((event) => event.type === 'load').length;

// A page whose policy blocks every script without the nonce
const policyPage = (body) =>
  `data:text/html,<meta http-equiv="Content-Security-Policy" content="script-src 'nonce-n'">${body}`;
const typed = (name) =>
  `data:text/html,<title>${name}</title><script>console.log('RAN ${name}')</script>`;

let engine = null;
const ready = new Promise((resolve) => {
  runEngine({
    enginePath,
    url: policyPage(`<script>console.log('RAN own')</script>`),
    width: 400,
    height: 300,
    onConsole(message) {
      consoleLines.push(message);
      notify();
    },
    onEvent(event) {
      engine = event.engine;
      events.push({ type: event.type, payload: event.payload });
      notify();
      resolve();
    },
    onPrint(text) {
      const match = /^\[eval 1\] (.*) \(painting allowed/.exec(text);
      if (match) {
        evalResults.push(match[1]);
        notify();
      }
    },
  }).catch((error) => {
    console.error(error);
    process.exit(1);
  });
});

const load = async (url) => {
  const before = loads();
  engine._bl_load_url(1, engine.stringToNewUTF8(url));
  await waitFor(() => loads() > before);
};
const evaluate = async (source) => {
  const before = evalResults.length;
  engine._bl_eval_script(1, engine.stringToNewUTF8(source));
  return waitFor(() => evalResults.length > before && evalResults[before]);
};
// Whether a script the document inserts itself (no nonce) runs under its policy
const insertedScriptRuns = () =>
  evaluate(`(() => {
    window.inserted = false;
    const script = document.createElement('script');
    script.textContent = 'window.inserted = true';
    document.documentElement.append(script);
    return String(window.inserted);
  })()`);
const ran = (name) => consoleLines.includes(`RAN ${name}`);

await ready;
await waitFor(() => loads() >= 1);
check('the policy of the first page blocks its own script', !ran('own'));
check('the first page blocks an inserted script', (await insertedScriptRuns()) === 'false');

// 1. A data: address typed right after the page
await load(typed('data'));
check('a typed data: address runs its script', ran('data'), consoleLines.join(' | '));
check('a typed data: address has no policy', (await insertedScriptRuns()) === 'true');

// 2. about:blank typed after the page, then data:
await load(policyPage('<p>again</p>'));
await load('about:blank');
check('a typed about:blank has no policy', (await insertedScriptRuns()) === 'true');
await load(typed('after-blank'));
check('a data: address typed after about:blank runs its script', ran('after-blank'));

// 3. A navigation of the page itself still passes the policy on (HTML spec)
await load(policyPage(`<script nonce="n">location.href = 'about:blank%23page'</script>`));
let url = '';
for (let tries = 0; tries < 50 && url !== 'about:blank#page'; tries += 1) {
  await new Promise((resolve) => setTimeout(resolve, 100));
  url = await evaluate('location.href');
}
check('the page navigated to about:blank', url === 'about:blank#page', url);
check(
  'about:blank opened by the page inherits its policy',
  (await insertedScriptRuns()) === 'false',
);

clearTimeout(timeout);
console.log(
  failed.length ? `ADDRESS POLICY failed: ${failed.join(', ')}` : 'ADDRESS POLICY done=ok',
);
process.exit(failed.length ? 1 : 0);
