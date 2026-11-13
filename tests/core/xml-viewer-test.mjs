// XML documents without style information show WebKit's XML tree viewer in the top frame, like
// Chrome and Firefox (patch 0133): an Atom feed shows its tags indented with buttons that fold
// them, and the escaped HTML of its entries stays text in the tree. Before, the viewer was only
// on with developer extras, so a feed showed all its text nodes run together. Documents with a
// stylesheet or with elements of a known namespace (XHTML) are rendered as before, a feed in a
// frame stays plain, and with JavaScript off (the viewer is a script) the feed shows as before.
//
//   node tests/core/xml-viewer-test.mjs [engine-dir]
import {
  check,
  collect,
  evalPage,
  finish,
  launch,
  load,
  openHost,
  serve,
  startStack,
  timeLimit,
  waitEvent,
  waitFor,
} from '../lib/index.mjs';

timeLimit();

const FEED = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Inside Feed</title>
  <entry>
    <title>First entry</title>
    <content type="html">&lt;p&gt;Escaped &lt;b&gt;markup&lt;/b&gt;&lt;/p&gt;</content>
  </entry>
</feed>`;

const { url } = await serve((req, res) => {
  const path = req.url.slice(1);
  const xml = (body) => res.writeHead(200, { 'Content-Type': 'application/xml' }).end(body);
  if (path === 'feed.xml') return xml(FEED);
  if (path === 'styled.xml')
    return xml(
      `<?xml-stylesheet type="text/css" href="feed.css"?>${FEED.replace(/^<\?xml[^>]*>/, '')}`,
    );
  if (path === 'feed.css')
    return res.writeHead(200, { 'Content-Type': 'text/css' }).end('entry { display: block }');
  if (path === 'page.xhtml')
    return res
      .writeHead(200, { 'Content-Type': 'application/xhtml+xml' })
      .end('<html xmlns="http://www.w3.org/1999/xhtml"><body><p>xhtml</p></body></html>');
  if (path === 'frame')
    return res
      .writeHead(200, { 'Content-Type': 'text/html' })
      .end('<title>frame</title><iframe src="feed.xml"></iframe>');
  res.writeHead(404).end();
});

const stack = await startStack();
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
const results = collect(page);
check('host page starts', await openHost(page, stack.app({ url: 'about:blank' })));

let probes = 0;
/** Value of expression (may be a promise) in the page of the active view, through JSON. */
async function probe(expression, target = 'document') {
  const key = `probe${++probes}`;
  const source = `Promise.resolve().then(() => ${expression.replace(/\bdocument\b/g, target)})
    .then((value) => value ?? null, (error) => 'error ' + error)
    .then((value) => console.log('RESULT ${key}=' + encodeURIComponent(JSON.stringify(value))))`;
  await evalPage(page, source);
  const raw = await results.wait(key, 15000);
  return raw === null ? 'no answer' : JSON.parse(decodeURIComponent(raw));
}
/** Opens address and waits until its document is complete. */
async function open(address) {
  await load(page, address);
  const ready = `location.href === ${JSON.stringify(address)} && document.readyState === 'complete'`;
  return waitFor(async () => (await probe(ready)) === true, 20000, 200);
}
/** Root element of the document and the lines of the tree viewer (-1 without a tree). */
const viewer = (target) =>
  probe(
    "({ root: document.documentElement.localName, lines: document.getElementById('tree')?.querySelectorAll('.line').length ?? -1 })",
    target,
  );
/** Matches of text found in the view (find in page), -1 without an answer. */
async function found(text) {
  await page.evaluate(() => window.blHost.events.splice(0));
  await page.evaluate((text) => window.blTest.view().find(text), text);
  const event = await waitEvent(page, /^find:/, 10000);
  await page.evaluate(() => window.blTest.view().stopFind());
  return event ? Number(event.split(':').pop()) : -1;
}

check('the feed loads', await open(`${url}feed.xml`));
let feed = null;
await waitFor(async () => (feed = await viewer()).lines > 3, 10000, 200);
check(
  'the feed is shown as an XML tree',
  feed.root === 'html' && feed.lines > 3,
  JSON.stringify(feed),
);
check(
  'the tree says why it is shown',
  (await probe(
    "document.querySelector('.header').textContent.includes('does not appear to have any style information')",
  )) === true,
);
check(
  'the content type stays that of the response',
  (await probe('document.contentType')) === 'application/xml',
);
check('its tags are visible', (await found('<entry>')) > 0);
check('escaped HTML of an entry stays text', (await found('<p>Escaped <b>markup</b></p>')) > 0);
const folded = await probe(
  "(() => { const button = document.querySelector('.collapse-button'); const section = button.closest('.collapsible'); button.click(); return section.querySelector(':scope > .expanded').classList.contains('hidden'); })()",
);
check('a section folds with its button', folded === true, JSON.stringify(folded));

check('a feed with a stylesheet loads', await open(`${url}styled.xml`));
const styled = await viewer();
check(
  'a feed with a stylesheet is rendered with it',
  styled.root === 'feed' && styled.lines === -1,
  JSON.stringify(styled),
);

check('an XHTML page loads', await open(`${url}page.xhtml`));
const xhtml = await viewer();
check(
  'an XHTML page is rendered as a page',
  xhtml.root === 'html' && xhtml.lines === -1,
  JSON.stringify(xhtml),
);

check('a page with the feed in a frame loads', await open(`${url}frame`));
await probe(
  "new Promise((resolve) => { const frame = document.querySelector('iframe'); frame.contentDocument?.readyState === 'complete' ? resolve() : frame.onload = resolve; })",
);
const framed = await viewer("document.querySelector('iframe').contentDocument");
check(
  'a feed in a frame is not turned into a tree',
  framed.root === 'feed' && framed.lines === -1,
  JSON.stringify(framed),
);

// Scripts of the page do not run with JavaScript off, neither do the probes: find in page instead
await page.evaluate(() => window.blTest.browser.setPreferences({ javascript: false }));
await page.evaluate(() => window.blHost.events.splice(0));
await load(page, `${url}feed.xml`);
check(
  'the feed loads with JavaScript off',
  (await waitEvent(page, `navigation:${url}feed.xml`, 20000)) &&
    (await waitFor(async () => (await found('First entry')) > 0, 20000, 200)),
);
check(
  'with JavaScript off the feed is shown as before, not as an empty tree',
  (await found('does not appear to have any style information')) === 0,
);
await browser.close();
finish();
