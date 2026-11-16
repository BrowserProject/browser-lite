// Content-Encoding like Chromium: a response whose Content-Encoding names a coding the engine
// cannot decode ("UTF-8" from www.migros.ch, "foo") keeps its body as it is, also when the list or
// a further header line has a known coding next to it. Before deps/patches/curl/0004 curl failed
// such a response (error 61), fetch() rejected with "Load failed" and a navigation showed the
// error page. Known codings, also stacked, are still decoded, and gzip that does not decode is
// still an error.
//
//   node tests/core/content-encoding-test.mjs [engine-dir]
import zlib from 'node:zlib';
import {
  TIMEOUT,
  check,
  collect,
  finish,
  launch,
  load,
  openHost,
  serve,
  startStack,
  timeLimit,
} from '../lib/index.mjs';

timeLimit(TIMEOUT + 120000);

const BODY = Buffer.from('hello');
// Expected as in Chromium
const CASES = {
  utf8: { status: 403, encoding: 'UTF-8', body: BODY, expect: '403:hello' },
  foo: { encoding: 'foo', body: BODY, expect: '200:hello' },
  identity: { encoding: 'identity', body: BODY, expect: '200:hello' },
  gzip: { encoding: 'gzip', body: zlib.gzipSync(BODY), expect: '200:hello' },
  stacked: {
    encoding: 'gzip, br',
    body: zlib.brotliCompressSync(zlib.gzipSync(BODY)),
    expect: '200:hello',
  },
  listed: { encoding: 'gzip, foo', body: BODY, expect: '200:hello' },
  unknownLast: { encoding: ['gzip', 'foo'], body: BODY, expect: '200:hello' },
  unknownFirst: { encoding: ['foo', 'gzip'], body: BODY, expect: '200:hello' },
  badGzip: { encoding: 'gzip', body: BODY, expect: 'error' },
};

const PAGE = `<!doctype html><title>content-encoding</title><script>
for (const name of ${JSON.stringify(Object.keys(CASES))})
  fetch('/ce?case=' + name, { cache: 'no-store' })
    .then(async (r) => r.status + ':' + (await r.text()))
    .catch(() => 'error')
    .then((value) => console.log('RESULT ' + name + '=' + value));
</script>`;

const DOCUMENT = `<!doctype html><title>document</title><script>console.log('RESULT document=shown')</script>`;

const site = await serve((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/document') {
    res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'UTF-8' });
    res.end(DOCUMENT);
    return;
  }
  const test = CASES[url.searchParams.get('case')];
  if (!test) {
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
    res.end(PAGE);
    return;
  }
  res.statusCode = test.status ?? 200;
  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Content-Encoding', test.encoding);
  res.end(test.body);
});

const stack = await startStack({ token: 'ce-token-0123456789abcdef' });
const browser = await launch();
const tab = await browser.newPage();
const results = collect(tab);

check('host page starts', await openHost(tab, stack.app({ url: 'about:blank' })));
await load(tab, site.url);
for (const [name, test] of Object.entries(CASES)) {
  const value = await results.wait(name, 30000);
  const encoding = [test.encoding].flat().join(' | ');
  check(`${name}, Content-Encoding "${encoding}": ${test.expect}`, value === test.expect, value);
}

await load(tab, `${site.url}document`);
check(
  'a navigation to a document with Content-Encoding "UTF-8" shows it',
  (await results.wait('document', 30000)) === 'shown',
);

await browser.close();
site.server.close();
finish();
