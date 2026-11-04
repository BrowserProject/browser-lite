// A form (POST) is only sent again after the user confirms, like in Chrome, Firefox and Safari:
// reload and back/forward to a form result that is not in the back/forward cache ask the dialog
// handler (type resubmit) first. No keeps the page and sends nothing, yes sends the form again
// with its data. A question the page makes obsolete (it navigates meanwhile) aborts, and back to
// a form result from the back/forward cache neither asks nor sends.
//
//   node tests/core/resubmit-test.mjs [engine-dir]
import {
  SWIFTSHADER,
  TIMEOUT,
  check,
  evalPage,
  finish,
  hostEvents,
  launch,
  openHost,
  serve,
  startStack,
  timeLimit,
  waitFor,
} from '../lib/index.mjs';

timeLimit(TIMEOUT + 240000);

const form = (action) =>
  `<!doctype html><title>FORM</title><form method="post" action="${action}"><input name="item" value="pizza"><button>Order</button></form>`;
const posts = [];
const { url: siteURL } = await serve((req, res) => {
  const path = new URL(req.url, siteURL).pathname;
  const html = (body) =>
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(body);
  if (req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      posts.push(`${path}:${body}`);
      // /order goes into the back/forward cache; WebCore never caches /order-sensor, a page
      // that listens to device motion
      html(
        path === '/order'
          ? `<!doctype html><title>ORDER|${posts.length}|${body}</title><p>Order placed #${posts.length}</p>`
          : `<!doctype html><title>SENSOR|${posts.length}|${body}</title><script>addEventListener('devicemotion', () => {})</script>`,
      );
    });
    return;
  }
  if (path === '/form') return html(form('/order'));
  if (path === '/form-sensor') return html(form('/order-sensor'));
  if (path === '/next') return html('<!doctype html><title>NEXT</title><p>Next page</p>');
  res.writeHead(404).end();
});

const browser = await launch({ args: SWIFTSHADER });
const stack = await startStack();
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
check('host page started a browser', await openHost(page, stack.app({ url: `${siteURL}form` })));
await page.evaluate(() => {
  window.blHost.dialogMode = 'hold';
});

const title = () => page.evaluate(() => window.blTest.view()?.title ?? '');
const address = () => page.evaluate(() => window.blTest.view()?.url ?? '');
const waitTitle = async (prefix, ms = 30000) => {
  await waitFor(async () => (await title()).startsWith(prefix), ms);
  return title();
};
const call = (method) => page.evaluate((method) => window.blTest.view()[method](), method);
const answer = (value) => page.evaluate((value) => window.blHost.answerDialog('', value), value);
const count = async (event) => (await hostEvents(page)).filter((e) => e === event).length;
// Until the n-th resubmit question reached the handler
const asked = (n, ms = 20000) => waitFor(async () => (await count('dialog:resubmit:')) >= n, ms);

check('form page loaded', (await waitTitle('FORM', 60000)) === 'FORM');
await evalPage(page, 'document.forms[0].submit()');
check('the form is sent once', (await waitTitle('ORDER|')) === 'ORDER|1|item=pizza', posts.join());

// Reload asks first and sends nothing until the answer; no keeps the page
await call('reload');
check('reload of a form result asks (resubmit)', await asked(1));
const dialog = await page.evaluate(() => window.blHost.dialogs.at(-1));
check(
  'the question has the origin of the page and no page text',
  dialog?.origin === new URL(siteURL).origin && dialog?.message === '',
  JSON.stringify(dialog),
);
await page.waitForTimeout(1000);
check('nothing sent while the question is open', posts.length === 1, posts.join());
check('cancel answered', await answer(false));
await page.waitForTimeout(1500);
check(
  'cancel keeps the page and sends nothing',
  posts.length === 1 &&
    (await title()) === 'ORDER|1|item=pizza' &&
    (await address()).endsWith('/order'),
  `${posts.join()} ${await title()}`,
);

// Yes sends the form again with its data
await call('reload');
check('reload asks again', await asked(2));
await answer(true);
check(
  'continue sends the form again',
  (await waitTitle('ORDER|2')) === 'ORDER|2|item=pizza' && posts.length === 2,
  posts.join(),
);

// The page navigates while the question is open: it ends, nothing is sent
await evalPage(page, "setTimeout(() => { location.href = '/next'; }, 1500)");
await call('reload');
check('reload asks a third time', await asked(3));
check(
  'the page navigating meanwhile withdraws the question',
  await waitFor(async () => (await count('dialog-aborted:')) >= 1, 20000),
);
check(
  'the page went on to its own target without sending',
  (await waitTitle('NEXT')) === 'NEXT' && posts.length === 2,
  posts.join(),
);

// Back to the form result from the back/forward cache: no question, no request
await call('back');
check('back shows the form result again', (await waitTitle('ORDER|')) === 'ORDER|2|item=pizza');
await page.waitForTimeout(1000);
check(
  'back from the back/forward cache neither asks nor sends',
  (await count('dialog:resubmit:')) === 3 && posts.length === 2,
  posts.join(),
);

// Back to a form result that is not cached asks too; no stays, yes sends again
await page.evaluate((url) => window.blTest.load(url), `${siteURL}form-sensor`);
await waitTitle('FORM');
await evalPage(page, 'document.forms[0].submit()');
check('second form sent', (await waitTitle('SENSOR|')) === 'SENSOR|3|item=pizza', posts.join());
await page.evaluate((url) => window.blTest.load(url), `${siteURL}next`);
await waitTitle('NEXT');
await call('back');
check('back to an uncached form result asks', await asked(4));
await page.waitForTimeout(1000);
check('back sends nothing while the question is open', posts.length === 3, posts.join());
await answer(false);
await page.waitForTimeout(1500);
check(
  'cancel stays on the current page',
  posts.length === 3 && (await title()) === 'NEXT' && (await address()).endsWith('/next'),
  `${posts.join()} ${await title()} ${await address()}`,
);
await call('back');
check('back asks again', await asked(5));
await answer(true);
check(
  'continue goes back and sends the form again',
  (await waitTitle('SENSOR|4')) === 'SENSOR|4|item=pizza' &&
    posts.at(-1) === '/order-sensor:item=pizza',
  posts.join(),
);

const events = await hostEvents(page);
check(
  'no unresponsive event and no crash',
  !events.some((event) => event === 'unresponsive' || event.startsWith('crash:')),
);

await browser.close();
finish();
