// Error page in node without a browser. Without Module.blTransport every navigation fails, so
// the view shows the error page from a custom BL_ERROR_PAGE. Checks the placeholders and their
// escaping, the CSP after the doctype (no script of the template runs), the 'commit' and
// 'title' events, the retry through [data-bl-retry] and the close reason 'name-not-resolved'
// of a transport.
//
//   node tests/engine/error-page-test.mjs build/webcore/bin/engine.js
import { runEngine } from './engine-node.mjs';

const enginePath = process.argv[2];
if (!enginePath) {
  console.error('Usage: error-page-test.mjs <engine.js>');
  process.exit(2);
}

// The host may contain " ' & (not < >), the path ' and &
const host = `a&b'c"d.invalid`;
const firstURL = `https://${host}/p'q&r`;
process.env.BL_TEST_HOOKS = '1';
process.env.BL_ERROR_PAGE = `
<!DOCTYPE html><html lang="{{lang}}" data-kind="{{kind}}"><head><title>{{title}}</title></head><body>
<h1>{{heading}}</h1><p id="message">{{message}}</p><p id="code">{{code}}</p>
<a id="link" title='{{url}}' data-host="{{title}}">{{url}}</a>
<button data-bl-retry>{{retryLabel}}</button><p id="unknown">{{unknown}}</p>
<script>console.log('SCRIPT RAN')</script><img src="https://example.invalid/i.png" onerror="console.log('SCRIPT RAN')">
</body></html>`;

const failed = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ` (${detail})`}`);
  if (!ok)
    failed.push(name);
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
  for (const waiter of [...waiters])
    waiter();
};
// Resolves once predicate() returns something truthy (checked on every event)
const waitFor = (predicate) => new Promise((resolve) => {
  const test = () => {
    const value = predicate();
    if (!value)
      return;
    waiters.splice(waiters.indexOf(test), 1);
    resolve(value);
  };
  waiters.push(test);
  test();
});
const titles = () => events.filter((event) => event.type === 'title').map((event) => JSON.parse(event.payload));
const count = (type) => events.filter((event) => event.type === type).length;

let engine = null;
const evaluate = async (source) => {
  const before = evalResults.length;
  engine._bl_eval_script(1, engine.stringToNewUTF8(source));
  return waitFor(() => evalResults.length > before && evalResults[before]);
};

runEngine({
  enginePath,
  url: firstURL,
  width: 400,
  height: 300,
  onConsole(message) {
    consoleLines.push(message);
  },
  onEvent(event) {
    engine = event.engine;
    events.push({ type: event.type, payload: event.payload });
    notify();
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

const pageState = `JSON.stringify({
  first: document.head.firstElementChild.outerHTML,
  compat: document.compatMode,
  lang: document.documentElement.lang,
  kind: document.documentElement.dataset.kind,
  heading: document.querySelector('h1').textContent,
  message: document.getElementById('message').textContent,
  code: document.getElementById('code').textContent,
  linkTitle: document.getElementById('link').title,
  linkText: document.getElementById('link').textContent,
  linkHost: document.getElementById('link').dataset.host,
  linkChildren: document.getElementById('link').children.length,
  unknown: document.getElementById('unknown').textContent,
  retry: document.querySelector('[data-bl-retry]').textContent,
  url: location.href,
  globals: Object.getOwnPropertyNames(window).filter((name) => name.startsWith('__bl')),
})`;

// 1. No transport: error page of kind network
await waitFor(() => count('commit') >= 1 && count('load') >= 1);
const commit = events.find((event) => event.type === 'commit');
check('commit reports errorPage network', commit.payload === '{"errorPage":"network"}', commit.payload);
const state = JSON.parse(await evaluate(pageState));
console.log(JSON.stringify(state));
check('CSP meta is the first element, after the doctype', state.first === `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">`, state.first);
check('doctype kept (standards mode)', state.compat === 'CSS1Compat', state.compat);
check('{{lang}} and {{kind}}', state.lang === 'en' && state.kind === 'network', `${state.lang} ${state.kind}`);
check('{{url}} escaped in a single quoted attribute', state.linkTitle === state.url && state.url.includes("'") && state.url.includes('&'), state.linkTitle);
check('{{url}} escaped as text', state.linkText === state.url && state.linkChildren === 0, state.linkText);
check('{{title}} escaped in a double quoted attribute', state.linkHost === host, state.linkHost);
check('{{message}} contains the escaped host', state.message.includes(host), state.message);
check('{{heading}} and {{code}} filled', state.heading.length > 0 && /^ERR_/.test(state.code), `${state.heading} / ${state.code}`);
check('unknown placeholders stay', state.unknown === '{{unknown}}', state.unknown);
check('{{retryLabel}} is Reload', state.retry === 'Reload', state.retry);
check('no __bl globals on the error page', state.globals.length === 0, state.globals.join());
// The title event may come after 'load'
await Promise.race([waitFor(() => titles().some((title) => title.title === host)), new Promise((resolve) => setTimeout(resolve, 5000))]);
check('title event carries the escaped host', titles().some((title) => title.title === host), JSON.stringify(titles()));

// 2. [data-bl-retry] loads the address again (still no transport: error page again)
await evaluate(`document.querySelector('[data-bl-retry]').click(), 'clicked'`);
await waitFor(() => count('commit') >= 2 && count('load') >= 2);
check('retry loads again', events.filter((event) => event.type === 'commit').pop().payload === '{"errorPage":"network"}');

// 3. A transport that reports 'name-not-resolved'
const opened = [];
engine.blTransport = {
  openTCP(targetHost, port) {
    opened.push(`${targetHost}:${port}`);
    const stream = { send() {}, close() {}, onopen: null, ondata: null, onsent: null, onclose: null };
    setTimeout(() => stream.onclose?.('name-not-resolved'), 0);
    return stream;
  },
};
engine._bl_load_url(1, engine.stringToNewUTF8('https://example.invalid/'));
await waitFor(() => count('commit') >= 3 && count('load') >= 3);
const resolved = JSON.parse(await evaluate(pageState));
check('transport asked for the host', opened.includes('example.invalid:443'), opened.join());
check('name-not-resolved gives ERR_NAME_NOT_RESOLVED', resolved.code === 'ERR_NAME_NOT_RESOLVED', resolved.code);

check('no script of the template ran', !consoleLines.some((line) => line.includes('SCRIPT RAN')), consoleLines.join(' | '));

clearTimeout(timeout);
console.log(failed.length ? `ERROR PAGE failed: ${failed.join(', ')}` : 'ERROR PAGE done=ok');
process.exit(failed.length ? 1 : 0);
