// The names of downloads like in Chrome (WebKit patch 0155, Download::announce in
// engine/src/LoaderStrategy.cpp): Content-Disposition after RFC 6266 (parameter names in any case,
// quoted strings with a ';' or escaped quotes inside), filename* (RFC 8187) before filename, a
// filename as RFC 2047 encoded word or percent-encoded UTF-8, raw UTF-8 bytes; without a header the
// last path segment of the address, percent-decoded. Path separators become '_'. Before, filename*
// was ignored, a quoted ';' cut the parameter off (the address named the file) and names from the
// address stayed percent-encoded.
//
//   node tests/core/download-names-test.mjs [engine-dir]
import {
  check,
  finish,
  launch,
  load,
  openHost,
  serve,
  startStack,
  timeLimit,
  waitFor,
} from '../lib/index.mjs';

timeLimit();

/** Address, Content-Disposition (null: none) and the name Chrome gives the file. */
const CASES = [
  [
    '/both',
    `attachment; filename="fallback.txt"; filename*=UTF-8''Gr%C3%BC%C3%9Fe%20%E2%82%AC.txt`,
    'Grüße €.txt',
  ],
  ['/onlystar', `attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.txt`, 'résumé.txt'],
  ['/latin1star', `attachment; filename*=iso-8859-1'fr'caf%E9.txt`, 'café.txt'],
  ['/badstar', `attachment; filename*=UTF-8''%FF%FE.txt; filename="valid.txt"`, 'valid.txt'],
  ['/semi', 'attachment; filename="a;b.txt"', 'a;b.txt'],
  ['/escaped', 'attachment; filename="say \\"hi\\".txt"; size=3', 'say "hi".txt'],
  ['/upper', 'ATTACHMENT; FileName=upper.txt', 'upper.txt'],
  ['/raw', 'attachment; filename="Grüße raw.txt"', 'Grüße raw.txt'],
  ['/rfc2047', 'attachment; filename="=?UTF-8?B?w6TDtsO8LnR4dA==?="', 'äöü.txt'],
  ['/percent', 'attachment; filename="%E2%82%AC%20rate.txt"', '€ rate.txt'],
  ['/slash', 'attachment; filename="dir/file.txt"', 'dir_file.txt'],
  ['/files/Gr%C3%BC%C3%9Fe%20Datei.bin', null, 'Grüße Datei.bin'],
  ['/files/a%2Fb.bin', null, 'a_b.bin'],
];

const { url } = await serve((req, res) => {
  if (req.url === '/')
    return res.writeHead(200, { 'Content-Type': 'text/html' }).end('<title>start</title>');
  const found = CASES.find(([path]) => path === req.url);
  if (!found) return res.writeHead(404).end();
  const headers = { 'Content-Type': 'application/octet-stream' };
  // Raw UTF-8 bytes in the header, as servers send them
  if (found[1]) headers['Content-Disposition'] = Buffer.from(found[1]).toString('latin1');
  res.writeHead(200, headers).end('file\n');
});

const stack = await startStack();
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
check('host page starts', await openHost(page, stack.app({ url })));

for (const [path, , expected] of CASES) {
  const before = await page.evaluate(() => window.blHost.downloads.length);
  await load(page, `${url}${path.slice(1)}`);
  const started = await waitFor(
    () => page.evaluate((n) => window.blHost.downloads.length > n, before),
    15000,
  );
  const name = await page.evaluate((n) => window.blHost.downloads[n]?.filename ?? null, before);
  check(
    `${path} is named ${JSON.stringify(expected)}`,
    started && name === expected,
    JSON.stringify(name),
  );
}

await browser.close();
finish();
