// Error page in node without a browser. Without Module.blTransport every navigation fails, so
// the view shows the error page from a custom BL_ERROR_PAGE. Checks the placeholders and their
// escaping, the CSP after the doctype (no script of the template runs), the 'commit' and
// 'title' events, the retry through [data-bl-retry], the close reason 'name-not-resolved'
// of a transport, the page for a file: address without a file and for an about: address
// WebCore does not load, for a restricted port or an address of only zeros, for redirects
// the engine stops (a loop, a redirect to file:) and for an HTTP error status without a body
// (kind http, like Chrome). An invalid address loads nothing.
//
//   node tests/engine/error-page-test.mjs [engine-dir]
import { enginePath as resolveEngine, runEngine } from './engine-node.mjs';

const enginePath = resolveEngine(process.argv[2]);

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
// Resolves once predicate() returns something truthy (checked on every event)
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
const titles = () =>
  events.filter((event) => event.type === 'title').map((event) => JSON.parse(event.payload));
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
check(
  'commit reports errorPage network',
  commit.payload === '{"errorPage":"network"}',
  commit.payload,
);
const state = JSON.parse(await evaluate(pageState));
console.log(JSON.stringify(state));
check(
  'CSP meta is the first element, after the doctype',
  state.first ===
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">`,
  state.first,
);
check('doctype kept (standards mode)', state.compat === 'CSS1Compat', state.compat);
check(
  '{{lang}} and {{kind}}',
  state.lang === 'en' && state.kind === 'network',
  `${state.lang} ${state.kind}`,
);
check(
  '{{url}} escaped in a single quoted attribute',
  state.linkTitle === state.url && state.url.includes("'") && state.url.includes('&'),
  state.linkTitle,
);
check(
  '{{url}} escaped as text',
  state.linkText === state.url && state.linkChildren === 0,
  state.linkText,
);
check('{{title}} escaped in a double quoted attribute', state.linkHost === host, state.linkHost);
check('{{message}} contains the escaped host', state.message.includes(host), state.message);
check(
  '{{heading}} and {{code}} filled',
  state.heading.length > 0 && /^ERR_/.test(state.code),
  `${state.heading} / ${state.code}`,
);
check('unknown placeholders stay', state.unknown === '{{unknown}}', state.unknown);
check('{{retryLabel}} is Reload', state.retry === 'Reload', state.retry);
check('no __bl globals on the error page', state.globals.length === 0, state.globals.join());
// The title event may come after 'load'
await Promise.race([
  waitFor(() => titles().some((title) => title.title === host)),
  new Promise((resolve) => setTimeout(resolve, 5000)),
]);
check(
  'title event carries the escaped host',
  titles().some((title) => title.title === host),
  JSON.stringify(titles()),
);

// 2. [data-bl-retry] loads the address again (still no transport: error page again)
await evaluate(`document.querySelector('[data-bl-retry]').click(), 'clicked'`);
await waitFor(() => count('commit') >= 2 && count('load') >= 2);
check(
  'retry loads again',
  events.filter((event) => event.type === 'commit').pop().payload === '{"errorPage":"network"}',
);

// 3. A transport that reports 'name-not-resolved'
const opened = [];
engine.blTransport = {
  openTCP(targetHost, port) {
    opened.push(`${targetHost}:${port}`);
    const stream = {
      send() {},
      close() {},
      onopen: null,
      ondata: null,
      onsent: null,
      onclose: null,
    };
    setTimeout(() => stream.onclose?.('name-not-resolved'), 0);
    return stream;
  },
};
engine._bl_load_url(1, engine.stringToNewUTF8('https://example.invalid/'));
await waitFor(() => count('commit') >= 3 && count('load') >= 3);
const resolved = JSON.parse(await evaluate(pageState));
check('transport asked for the host', opened.includes('example.invalid:443'), opened.join());
check(
  'name-not-resolved gives ERR_NAME_NOT_RESOLVED',
  resolved.code === 'ERR_NAME_NOT_RESOLVED',
  resolved.code,
);

// 4. Addresses that are no web addresses keep the address and show the page instead of an
// empty download (file:) or nothing (about:). A file that exists still loads.
const settled = (predicate) =>
  Promise.race([waitFor(predicate), new Promise((resolve) => setTimeout(resolve, 15000))]);
for (const [url, code] of [
  ['file:///no/such/page.html', 'ERR_FILE_NOT_FOUND'],
  ['file:///usr/share/webkit/', 'ERR_FILE_NOT_FOUND'],
  ['about:foo', 'ERR_INVALID_URL'],
]) {
  const before = {
    commit: count('commit'),
    load: count('load'),
    downloads: count('download-start'),
  };
  engine._bl_load_url(1, engine.stringToNewUTF8(url));
  await settled(() => count('commit') > before.commit && count('load') > before.load);
  const committed = events.filter((event) => event.type === 'commit').slice(before.commit);
  check(
    `${url} commits an error page`,
    committed.length === 1 && committed[0].payload === '{"errorPage":"network"}',
    JSON.stringify(committed),
  );
  check(`${url} starts no download`, count('download-start') === before.downloads);
  if (!committed.length) continue;
  const shown = JSON.parse(await evaluate(pageState));
  check(`${url} keeps its address`, shown.url === url, shown.url);
  check(`${url} gives ${code}`, shown.code === code, shown.code);
  check(`${url} names the address`, shown.message.includes(url), shown.message);
}
const image = 'file:///usr/share/webkit/images/missingImage.png';
const beforeImage = { commit: count('commit'), load: count('load') };
engine._bl_load_url(1, engine.stringToNewUTF8(image));
await settled(() => count('commit') > beforeImage.commit && count('load') > beforeImage.load);
const imageCommit = events.filter((event) => event.type === 'commit').slice(beforeImage.commit);
check(
  'an existing file: address still loads',
  imageCommit.length === 1 &&
    imageCommit[0].payload === '' &&
    (await evaluate('location.href + " " + document.contentType')) === `${image} image/png`,
  JSON.stringify(imageCommit),
);

// 5. Addresses WebCore refuses before the request (FrameLoader::blockedError, marked as a
// cancellation) still get an error event and the page, like Chrome. Neither the preconnect of
// the address bar nor the favicon of the error page connects there.
for (const [url, code, named] of [
  ['http://example.com:6000/', 'ERR_UNSAFE_PORT', 'example.com:6000'],
  ['https://127.0.0.1:1/x', 'ERR_UNSAFE_PORT', '127.0.0.1:1'],
  ['http://0.0.0.0/', 'ERR_ADDRESS_INVALID', '0.0.0.0'],
]) {
  const before = { commit: count('commit'), load: count('load'), error: count('error') };
  const asked = opened.length;
  engine._bl_preconnect(engine.stringToNewUTF8(url));
  engine._bl_load_url(1, engine.stringToNewUTF8(url));
  await settled(() => count('commit') > before.commit && count('load') > before.load);
  const failures = events.filter((event) => event.type === 'error').slice(before.error);
  check(
    `${url} reports an error event`,
    failures.length === 1 && JSON.parse(failures[0].payload).url === url,
    JSON.stringify(failures),
  );
  const committed = events.filter((event) => event.type === 'commit').slice(before.commit);
  check(
    `${url} commits an error page`,
    committed.length === 1 && committed[0].payload === '{"errorPage":"network"}',
    JSON.stringify(committed),
  );
  if (committed.length) {
    const shown = JSON.parse(await evaluate(pageState));
    check(`${url} keeps its address`, shown.url === url, shown.url);
    check(`${url} gives ${code}`, shown.code === code, shown.code);
    check(`${url} names ${named}`, shown.message.includes(named), shown.message);
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
  check(`${url} opens no connection`, opened.length === asked, opened.slice(asked).join());
}

// 6. Redirects the engine stops get the page like in Chrome, under the address that redirected:
// more than 20 (a loop) and a redirect to a file: address (whose file is not loaded).
const requests = [];
// Answers of status.test for section 8
const statusResponses = {
  '/500': 'HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\n\r\n',
  '/404': 'HTTP/1.1 404 Not Found\r\nContent-Type: text/html\r\nContent-Length: 0\r\n\r\n',
  '/403': 'HTTP/1.1 403 Forbidden\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n',
  '/404body':
    'HTTP/1.1 404 Not Found\r\nContent-Type: text/html\r\nContent-Length: 21\r\n\r\n<title>nf</title>gone',
  '/204': 'HTTP/1.1 204 No Content\r\n\r\n',
};
engine.blTransport = {
  openTCP(targetHost, port) {
    const stream = { close() {}, onopen: null, ondata: null, onsent: null, onclose: null };
    let received = '';
    stream.send = (data) => {
      setTimeout(() => stream.onsent?.(data.length), 0);
      received += new TextDecoder().decode(data);
      if (!received.includes('\r\n\r\n')) return;
      const path = received.split(' ')[1];
      received = '';
      requests.push(`${targetHost}${path}`);
      if (targetHost === 'status.test') {
        setTimeout(() => stream.ondata?.(new TextEncoder().encode(statusResponses[path])), 0);
        return;
      }
      const step = Number(path.split('/').pop()) || 0;
      const location =
        targetHost === 'loop.test'
          ? `/r/${step + 1}`
          : 'file:///usr/share/webkit/images/missingImage.png';
      const response = `HTTP/1.1 302 Found\r\nLocation: ${location}\r\nContent-Length: 0\r\n\r\n`;
      setTimeout(() => stream.ondata?.(new TextEncoder().encode(response)), 0);
    };
    setTimeout(() => (port === 80 ? stream.onopen?.() : stream.onclose?.('refused')), 0);
    return stream;
  },
};
for (const [url, code, named, expected] of [
  ['http://loop.test/r/0', 'ERR_TOO_MANY_REDIRECTS', 'loop.test', 21],
  ['http://file.test/', 'ERR_UNSAFE_REDIRECT', 'file.test', 1],
]) {
  const redirectHost = new URL(url).host;
  const before = { commit: count('commit'), load: count('load'), error: count('error') };
  engine._bl_load_url(1, engine.stringToNewUTF8(url));
  await settled(() => count('commit') > before.commit && count('load') > before.load);
  const asked = requests.filter((request) => request.startsWith(redirectHost));
  check(`${url} sends ${expected} requests`, asked.length === expected, asked.join());
  check(`${url} reports an error event`, count('error') === before.error + 1);
  const committed = events.filter((event) => event.type === 'commit').slice(before.commit);
  check(
    `${url} commits an error page`,
    committed.length === 1 && committed[0].payload === '{"errorPage":"network"}',
    JSON.stringify(committed),
  );
  if (!committed.length) continue;
  const shown = JSON.parse(await evaluate(pageState));
  check(
    `${url} keeps the address that redirected`,
    shown.url === `http://${asked.at(-1)}`,
    shown.url,
  );
  check(`${url} gives ${code}`, shown.code === code, shown.code);
  check(`${url} names ${named}`, shown.message.includes(named), shown.message);
}

// 7. An invalid address is not loaded, like in Chrome. With a scheme it never gets https:// in
// front, which made the scheme the host (https://http//example.com:99999/, #407).
for (const url of ['http://example.com:99999/', 'https://a b.test/']) {
  // The report of the beforeunload listener comes a step after the last page
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const before = { events: events.length, requests: requests.length };
  engine._bl_load_url(1, engine.stringToNewUTF8(url));
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const after = events
    .slice(before.events)
    .map((event) => (event.type === 'error' ? `error ${event.payload}` : event.type));
  check(`${url} is not loaded`, after.length === 0, after.join(' | '));
  check(
    `${url} opens no connection`,
    requests.length === before.requests,
    requests.slice(before.requests).join(),
  );
}
// Without a scheme the address still gets https:// in front
const beforePrefix = { commit: count('commit'), load: count('load'), error: count('error') };
engine._bl_load_url(1, engine.stringToNewUTF8('loop.test/r/20'));
await settled(() => count('commit') > beforePrefix.commit && count('load') > beforePrefix.load);
const prefixed = events.filter((event) => event.type === 'error').slice(beforePrefix.error);
check(
  'an address without a scheme gets https:// in front',
  prefixed.length === 1 && JSON.parse(prefixed[0].payload).url === 'https://loop.test/r/20',
  JSON.stringify(prefixed),
);

// 8. An HTTP error status without a body gets the page like in Chrome (kind http, "HTTP ERROR
// 500"), also when the length is not known before (chunked). With a body the page of the server
// shows; 204 stays on the page shown.
for (const [path, code, heading, named] of [
  ['/500', 'HTTP ERROR 500', "This page isn't working", 'status.test is currently unable'],
  ['/404', 'HTTP ERROR 404', "This page can't be found", 'http://status.test/404'],
  ['/403', 'HTTP ERROR 403', "This page isn't working", 'status.test'],
]) {
  const url = `http://status.test${path}`;
  const before = { commit: count('commit'), load: count('load'), error: count('error') };
  engine._bl_load_url(1, engine.stringToNewUTF8(url));
  await settled(() => count('commit') > before.commit && count('load') > before.load);
  check(`${url} reports an error event`, count('error') === before.error + 1);
  const committed = events.filter((event) => event.type === 'commit').slice(before.commit);
  check(
    `${url} commits an error page of kind http`,
    committed.length === 1 && committed[0].payload === '{"errorPage":"http"}',
    JSON.stringify(committed),
  );
  if (committed[0]?.payload !== '{"errorPage":"http"}') continue;
  const shown = JSON.parse(await evaluate(pageState));
  check(`${url} keeps the address`, shown.url === url, shown.url);
  check(`${url} {{kind}} is http`, shown.kind === 'http', shown.kind);
  check(`${url} gives ${code}`, shown.code === code, shown.code);
  check(`${url} says ${heading}`, shown.heading === heading, shown.heading);
  check(`${url} names ${named}`, shown.message.includes(named), shown.message);
}
{
  const url = 'http://status.test/404body';
  const before = { commit: count('commit'), load: count('load'), error: count('error') };
  engine._bl_load_url(1, engine.stringToNewUTF8(url));
  await settled(() => count('commit') > before.commit && count('load') > before.load);
  const committed = events.filter((event) => event.type === 'commit').slice(before.commit);
  check(
    `${url} commits the page of the server`,
    committed.length === 1 && !committed[0].payload && count('error') === before.error,
    JSON.stringify(committed),
  );
  const shown = JSON.parse(
    await evaluate('JSON.stringify({ url: location.href, text: document.body.textContent })'),
  );
  check(`${url} shows its body`, shown.url === url && shown.text === 'gone', JSON.stringify(shown));
}
{
  const before = { events: events.length, requests: requests.length };
  engine._bl_load_url(1, engine.stringToNewUTF8('http://status.test/204'));
  await waitFor(() => requests.length > before.requests);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const after = events.slice(before.events).map((event) => event.type);
  check('204 commits nothing', !after.includes('commit') && !after.includes('error'), after.join());
}

check(
  'no script of the template ran',
  !consoleLines.some((line) => line.includes('SCRIPT RAN')),
  consoleLines.join(' | '),
);

clearTimeout(timeout);
console.log(failed.length ? `ERROR PAGE failed: ${failed.join(', ')}` : 'ERROR PAGE done=ok');
process.exit(failed.length ? 1 : 0);
