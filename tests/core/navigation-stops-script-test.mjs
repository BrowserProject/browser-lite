// A navigation of the user stops the running script of the page it leaves (engine/src/
// UserNavigation.cpp), like Firefox: all views share the engine thread, and Back, Forward or a
// typed address otherwise waited until the script ended (a chart in an iframe on watson.ch held
// Back for 4 to 7 s on a phone). Checked: Back during a long script of the page and of a
// cross-origin iframe, a typed address, the page with the stopped script stays out of the
// back/forward cache; not stopped: Back to an entry of the same document (pushState), a
// navigation of another view, and everything with BL_NAVIGATION_STOPS_SCRIPTS=0 (the control,
// where Back waits for the script).
//
//   node tests/core/navigation-stops-script-test.mjs [engine-dir]
import {
  check,
  collect,
  evalPage,
  finish,
  launch,
  load,
  openHost,
  openView,
  serve,
  startStack,
  timeLimit,
} from '../lib/index.mjs';

timeLimit();

// Long enough that waiting for it is plain on a loaded machine
const LONG_MS = 20000;
// Scripts that must run to their end
const SHORT_MS = 4000;

// A page that logs its shows (persisted) and, unless ?ms=0, runs one busy script of ms after
// 300 ms; ?push=1 adds a history entry of the same document first, ?frame=<url> embeds a frame.
const page = (name, params) => {
  const ms = Number(params.get('ms') ?? 0);
  const frame = params.get('frame');
  return `<!doctype html><title>${name}</title><body>${name}
${frame ? `<iframe src="${frame}"></iframe>` : ''}<script>
addEventListener('pageshow', (event) => {
  const shows = Number(sessionStorage['shows_${name}'] || 0) + 1;
  sessionStorage['shows_${name}'] = shows;
  console.log('RESULT show_${name}' + shows + '=' + event.persisted);
});
if (${ms} && !sessionStorage['ran_${name}']) {
  sessionStorage['ran_${name}'] = 1;
  setTimeout(() => {
    ${params.get('push') ? "history.pushState(null, '', '#pushed');" : ''}
    console.log('RESULT start_${name}=' + Date.now());
    const end = performance.now() + ${ms};
    while (performance.now() < end) {}
    console.log('RESULT done_${name}=' + Date.now());
  }, 300);
}
</script>`;
};

const handler = (req, res) => {
  const url = new URL(req.url, 'http://x');
  const name = url.pathname.slice(1);
  if (!/^[a-z0-9]+$/.test(name)) return res.writeHead(404).end();
  res
    .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    .end(page(name, url.searchParams));
};
const { url: siteURL } = await serve(handler);
// Another origin for the frame
const { url: frameSiteURL } = await serve(handler);

const stack = await startStack();
const browser = await launch();

async function openTab(env = '') {
  const tab = await browser.newPage();
  const results = collect(tab);
  check(
    `host page starts ${env}`,
    await openHost(tab, stack.app({ url: 'about:blank', log: '1', env })),
  );
  return { tab, results };
}

// Loads first (a plain page), then second; once second's script runs, calls go() of the view
// and returns how long the page shown before took to show again, and whether the script ended.
async function backDuringScript(label, results, tab, first, second, waitFor = `show_${first}2`) {
  await load(tab, `${siteURL}${first}`);
  check(`${label}: ${first} loads`, (await results.wait(`show_${first}1`)) === 'false');
  await load(tab, second.url);
  const started = await results.wait(`start_${second.name}`);
  check(`${label}: the script of ${second.name} starts`, !!started);
  const asked = Date.now();
  await tab.evaluate(() => window.blTest.view().back());
  const shown = await results.wait(waitFor, LONG_MS * 2);
  return {
    seconds: shown === null ? null : (Date.now() - asked) / 1000,
    shown,
    done: results.has(`done_${second.name}`),
  };
}

// Back during a script of the page: the script stops, the page left shows at once
{
  const { tab, results } = await openTab();
  const back = await backDuringScript('back', results, tab, 'home', {
    name: 'busy',
    url: `${siteURL}busy?ms=${LONG_MS}`,
  });
  check(
    'back during a long script shows the page before within 5 s',
    back.seconds !== null && back.seconds < 5,
    `${back.seconds} s, script of ${LONG_MS / 1000} s`,
  );
  check('the script was stopped (did not reach its end)', !back.done);
  check(
    'the engine logs the stop',
    results.logs.some((line) => line.includes('script stopped, the user leaves the page')),
  );
  // Forward: the page whose script was stopped was not kept in the back/forward cache
  await tab.evaluate(() => window.blTest.view().forward());
  check(
    'the page with the stopped script loads again on forward (not from the cache)',
    (await results.wait('show_busy2')) === 'false',
  );
  await tab.close();
}

// Back during a script of a cross-origin frame (the case of watson.ch)
{
  const { tab, results } = await openTab();
  const frame = encodeURIComponent(`${frameSiteURL}busyframe?ms=${LONG_MS}`);
  const back = await backDuringScript('frame', results, tab, 'start', {
    name: 'busyframe',
    url: `${siteURL}outer?frame=${frame}`,
  });
  check(
    'back during a long script of a cross-origin frame shows the page before within 5 s',
    back.seconds !== null && back.seconds < 5,
    `${back.seconds} s`,
  );
  await tab.close();
}

// A typed address during a script of the page
{
  const { tab, results } = await openTab();
  await load(tab, `${siteURL}typed?ms=${LONG_MS}`);
  check('typed: the script starts', !!(await results.wait('start_typed')));
  const asked = Date.now();
  await load(tab, `${siteURL}target`);
  const shown = await results.wait('show_target1', LONG_MS * 2);
  const seconds = (Date.now() - asked) / 1000;
  check(
    'a typed address during a long script shows within 5 s',
    shown !== null && seconds < 5,
    `${seconds} s`,
  );
  await tab.close();
}

// Back to an entry of the same document: the script runs to its end
{
  const { tab, results } = await openTab();
  const back = await backDuringScript(
    'same document',
    results,
    tab,
    'first',
    { name: 'pushed', url: `${siteURL}pushed?ms=${SHORT_MS}&push=1` },
    'done_pushed',
  );
  check(
    'back within the same document does not stop the script',
    back.shown !== null,
    `${back.seconds} s`,
  );
  await tab.close();
}

// A navigation of another view does not stop the script of this one
{
  const { tab, results } = await openTab();
  await load(tab, `${siteURL}one`);
  await results.wait('show_one1');
  await load(tab, `${siteURL}two`);
  await results.wait('show_two1');
  await openView(tab, `${siteURL}other?ms=${SHORT_MS}`);
  check('other view: the script starts', !!(await results.wait('start_other')));
  await tab.evaluate(() => window.blTest.views()[0].back());
  check(
    'back in another view does not stop the script of this one',
    (await results.wait('done_other', LONG_MS * 2)) !== null,
  );
  await tab.close();
}

// The control: without the stop Back waits for the script
{
  const { tab, results } = await openTab('BL_NAVIGATION_STOPS_SCRIPTS=0');
  const back = await backDuringScript('control', results, tab, 'home', {
    name: 'slow',
    url: `${siteURL}slow?ms=${SHORT_MS * 2}`,
  });
  check(
    'with BL_NAVIGATION_STOPS_SCRIPTS=0 back waits for the script to end',
    back.done && back.seconds !== null && back.seconds > (SHORT_MS * 2) / 1000 - 2,
    `${back.seconds} s`,
  );
  // The reference of the cache check above: a page left normally comes back from the cache
  await tab.evaluate(() => window.blTest.view().forward());
  check(
    'a page left without a stopped script comes back from the cache on forward',
    (await results.wait('show_slow2')) === 'true',
  );
  await tab.close();
}

await browser.close();
await stack.stop?.();
finish();
