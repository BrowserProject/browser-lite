// view-source: addresses (engine/src/ViewSource.cpp): a page of its own with history like in
// Chrome. viewSource() asks the host for a tab with the address, the engine loads the source
// itself (charset of the response, redirects followed) and shows it with numbered lines; back
// and forward come back to it, a reload loads it again. Pages cannot open it themselves (location,
// frame). Before, the host loaded the text as HTML without a history entry, so the
// next address of the tab left nothing to go back to.
//
//   node tests/core/view-source-test.mjs [engine-dir]
import {
  check,
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

let pageRequests = 0;
const { url } = await serve((req, res) => {
  const path = req.url.slice(1);
  if (path === 'page') {
    pageRequests++;
    // Latin-1 bytes: the source is decoded with the charset of the response
    res.writeHead(200, { 'Content-Type': 'text/html; charset=iso-8859-1' });
    res.end(
      Buffer.from(
        '<!doctype html><title>Caf\xe9</title>\n<p>first & <b>second</b>\r\nthird',
        'latin1',
      ),
    );
    return;
  }
  if (path === 'moved') {
    res.writeHead(302, { Location: '/page' }).end();
    return;
  }
  const bodies = {
    other: '<title>other</title>',
    // A page that tries to open a source itself: in a frame and with location
    sneaky: `<title>sneaky</title><iframe src="view-source:${url}page"></iframe>
<script>setTimeout(() => { location.href = 'view-source:${url}page'; }, 0)</script>`,
  };
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(bodies[path] ?? '');
});
const SOURCE = `view-source:${url}page`;

const stack = await startStack();
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
check('host page starts', await openHost(page, stack.app({ url: `${url}page`, log: '1' })));
check('page loads', await waitEvent(page, 'title:Café'));

const events = () => page.evaluate(() => window.blHost.events.splice(0));
const view = (key) => page.evaluate((key) => window.blTest.view()[key], key);
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The find event of text: 'find:<text>:<matches>', null without one. */
async function find(text) {
  await page.evaluate((text) => window.blTest.view().find(text), text);
  const found = await waitEvent(page, new RegExp(`^find:${escape(text)}:`), 10000);
  await page.evaluate(() => window.blTest.view().stopFind());
  return found;
}
const shows = async (text) => /:[1-9]/.test((await find(text)) ?? '');

await events();
await page.evaluate(() => window.blTest.view().viewSource());
check(
  'viewSource asks for a tab with the view-source: address in front',
  await waitEvent(page, `open-tab:foreground:${SOURCE}`, 10000),
);

await load(page, SOURCE);
check('the source page loads with its address as title', await waitEvent(page, `title:${SOURCE}`));
check('its address is the view-source: address', (await view('url')) === SOURCE, await view('url'));
check('the source is decoded with the charset of the response', await shows('<title>Café</title>'));
check('markup is shown as text', await shows('first & <b>second</b>'));

await events();
await load(page, `${url}other`);
check('another address loads in the same view', await waitEvent(page, 'title:other'));
check(
  'back is possible after leaving the source page',
  await waitFor(() => view('canGoBack'), 10000),
);

await events();
await page.evaluate(() => window.blTest.view().back());
check(
  'back shows the source page again',
  await waitFor(
    async () => (await view('url')) === SOURCE && (await view('title')) === SOURCE,
    15000,
  ),
  `${await view('url')} ${await view('title')}`,
);
check('its text is there again', await shows('<title>Café</title>'));
check('forward is possible', await view('canGoForward'));

await events();
const before = pageRequests;
await page.evaluate(() => window.blTest.view().reload());
check(
  'reload fetches the source again',
  await waitFor(() => pageRequests > before, 15000),
  `${before} -> ${pageRequests}`,
);
check('and shows it', await waitEvent(page, `title:${SOURCE}`));

await events();
await load(page, `view-source:${url}moved`);
check(
  'a redirect is followed, the address stays',
  await waitEvent(page, `title:view-source:${url}moved`),
);
check('the source is that of the target', await shows('<title>Café</title>'));

await events();
await load(page, `${url}sneaky`);
check('a page that tries to open a source loads', await waitEvent(page, 'title:sneaky'));
const blocked = await waitEvent(page, /^console:.*Not allowed to load view-source: address/, 10000);
check('its location change is refused with a console error', blocked, blocked ?? 'no message');
await new Promise((resolve) => setTimeout(resolve, 1000));
check('the view stays on the page', (await view('url')) === `${url}sneaky`, await view('url'));
check('its frame does not get the source', !(await shows('<title>Café</title>')));

await browser.close();
finish();
