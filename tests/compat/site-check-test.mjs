// The verdicts of site-check.mjs: an untitled almost empty page is found even when the page
// replaced its console, and a failure of the host page itself is reported as such and quickly,
// not as a hanging site. Local data: pages, no internet needed.
//
//   node tests/compat/site-check-test.mjs [engine-dir]
import { check, engineDir, finish, launch, startStack, timeLimit } from '../lib/index.mjs';
import { checkSite, within } from './site-check.mjs';

const TIMEOUT = 60000;
timeLimit(10 * (TIMEOUT + 30000));

const stack = await startStack({
  token: 'site-token-0123456789abcdef',
  allowLocal: false,
  engine: engineDir,
});
const browser = await launch();

// The verdict for site; prepare(page) may change the page first (for example route faults)
async function verdict(site, { prepare, params } = {}) {
  const page = await browser.newPage();
  await prepare?.(page);
  const log = [];
  const started = Date.now();
  let outcome;
  try {
    outcome = await within(
      checkSite(page, { stack, site, timeout: TIMEOUT, settle: 500, params, log }),
      TIMEOUT + 60000,
      'page hangs',
    );
  } catch (e) {
    outcome = { result: `threw: ${e.message}` };
  }
  await page.close();
  return { ...outcome, ms: Date.now() - started };
}

const empty = await verdict('data:text/html,<p>Forbidden</p>');
check(
  'an untitled almost empty page',
  empty.result === 'almost empty page: "Forbidden"',
  empty.result,
);

const silenced = await verdict(
  'data:text/html,<script>console.log=console.warn=console.error=console.info=()=>{}</script><p>Forbidden</p>',
);
check(
  'an untitled almost empty page that replaced its console',
  silenced.result === 'almost empty page: "Forbidden"',
  silenced.result,
);

const titled = await verdict('data:text/html,<title>Fine</title><p>Fine</p>');
check('a titled page is ok', titled.result === 'ok' && titled.title === 'Fine', titled.result);

// The host page's own address fails (like net::ERR_NETWORK_CHANGED while the run goes on)
const hostFailed = await verdict('data:text/html,<title>x</title>x', {
  prepare: (page) =>
    page.route(
      (url) => url.origin === new URL(stack.app({})).origin,
      (route) =>
        route.request().isNavigationRequest()
          ? route.abort('internetdisconnected')
          : route.continue(),
    ),
});
check(
  'a failed host page is reported as such',
  hostFailed.result.startsWith('host page failed: ') &&
    hostFailed.result.includes('ERR_INTERNET_DISCONNECTED'),
  hostFailed.result,
);

// The host page loads but its scripts do not
const noScripts = await verdict('data:text/html,<title>x</title>x', {
  prepare: (page) =>
    page.route(
      (url) => url.origin === new URL(stack.app({})).origin,
      (route) =>
        route.request().resourceType() === 'script'
          ? route.abort('internetdisconnected')
          : route.continue(),
    ),
});
check(
  'a host page whose scripts failed is reported quickly',
  noScripts.result.startsWith('host page did not start') && noScripts.ms < TIMEOUT,
  `${noScripts.result} (${noScripts.ms} ms)`,
);

// The host page runs but the engine does not start
const noEngine = await verdict('data:text/html,<title>x</title>x', {
  params: { engine: '/no-engine/' },
});
check(
  'an engine that did not start is reported quickly',
  noEngine.result.startsWith('engine did not start: ') && noEngine.ms < TIMEOUT,
  `${noEngine.result} (${noEngine.ms} ms)`,
);

await browser.close();
finish();
