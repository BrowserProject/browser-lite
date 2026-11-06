// Loads one site in browser-lite through the core test host page and judges the result; the run
// over many sites is site-test.mjs.

// How long the host page's own scripts may take to run after its load
const HOST_START = 30000;

// A promise with a time limit (page.evaluate has none and hangs when the page blocks)
export const within = (promise, ms, what) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(what)), ms)),
  ]);

/**
 * Opens site in page through the host page of stack and waits until it loaded, at most timeout
 * ms. params: further parameters of the host page, settle: ms to wait after the load, screenshot:
 * file for a screenshot or null, extraCA: an own CA in PEM, log: collects the console of the host.
 * Resolves { result, seconds, title, firstLayout, firstPaint }, result 'ok' or the problem.
 */
export async function checkSite(
  page,
  { stack, site, timeout, settle = 1500, params = {}, screenshot = null, extraCA = null, log },
) {
  if (extraCA)
    await page.addInitScript((pem) => {
      window.blTestOptions = { engine: { extraCA: pem } };
    }, extraCA);
  page.on('console', (msg) => log.push(msg.text()));
  const started = Date.now();
  // Problems of the host page itself are not the site's: report them as such, at once
  const hostProblem = (result) => ({
    result,
    seconds: '-',
    title: '',
    firstLayout: '-',
    firstPaint: '-',
  });
  try {
    await page.goto(stack.app({ url: site, ...params }));
  } catch (e) {
    return hostProblem(`host page failed: ${e.message.split('\n')[0]}`);
  }
  // host.js sets both at once when its module runs
  const hostStarted = await page
    .waitForFunction(() => !!window.blTest && !!window.blHost, null, { timeout: HOST_START })
    .then(() => true)
    .catch(() => false);
  if (!hostStarted) return hostProblem('host page did not start (its scripts did not run)');
  // First visible layout of the page and the first frame afterwards (the engine reports
  // "first-layout" and "first-paint")
  let firstLayout = '-';
  let firstPaint = '-';
  page
    .waitForFunction(() => window.blTest?.flags.firstLayout === true, null, {
      timeout,
      polling: 100,
    })
    .then(() => {
      firstLayout = ((Date.now() - started) / 1000).toFixed(1);
    })
    .catch(() => {});
  page
    .waitForFunction(() => window.blTest?.flags.firstPaint === true, null, {
      timeout,
      polling: 100,
    })
    .then(() => {
      firstPaint = ((Date.now() - started) / 1000).toFixed(1);
    })
    .catch(() => {});
  let result = 'ok';
  try {
    // Done when the page loaded, an error page or a load error came or the engine did not start
    await page.waitForFunction(
      () =>
        window.blTest.flags.loaded === true ||
        !!window.blHost.error ||
        window.blHost.events.some((e) => /^commit:./.test(e) || e.startsWith('error:')),
      null,
      { timeout, polling: 250 },
    );
    const error = await within(
      page.evaluate(() => window.blHost.error),
      10000,
      'engine state',
    );
    if (error) return hostProblem(`engine did not start: ${error.code}: ${error.message}`);
    const failed = await within(
      page.evaluate(
        () =>
          window.blHost.events.find((e) => /^commit:./.test(e) || e.startsWith('error:')) ?? null,
      ),
      10000,
      'state',
    );
    if (failed) result = `Error ${failed}`;
  } catch {
    result = 'time limit';
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  await page.waitForTimeout(settle);
  const viewTitle = () =>
    within(
      page.evaluate(() => window.blTest.view()?.title ?? ''),
      10000,
      'title',
    );
  let title = await viewTitle();
  // No title yet: often a bot check (for example AWS WAF) that computes and then reloads the real
  // page. Wait a little for it.
  if (!title) {
    await page
      .waitForFunction(() => !!window.blTest.view()?.title, null, { timeout: 30000, polling: 500 })
      .catch(() => {});
    title = await viewTitle();
  }
  // Without a title and with (almost) no text nothing real loaded (for example a short 403 answer of
  // an IP block), even when the view reports done
  if (result === 'ok' && !title) {
    // The engine prints the result of blTest.eval itself ('[eval N] <result> (painting ...)'), so
    // this works also on pages that replaced their console
    const marker = `SITECHECK${Date.now()}`;
    await within(
      page.evaluate(
        (m) =>
          window.blTest.eval(
            `"${m} " + JSON.stringify((document.body ? document.body.innerText : '').trim().slice(0, 200))`,
          ),
        marker,
      ),
      10000,
      'Text',
    ).catch(() => {});
    await page.waitForTimeout(1000);
    const line = log.find((l) => l.includes(`] ${marker} `));
    const text = line
      ? line
          .slice(line.indexOf(marker) + marker.length + 1)
          .replace(/ \(painting allowed .*\)$/, '')
      : null;
    if (text !== null && text.length < 200) result = `almost empty page: ${text}`;
  }
  if (screenshot) await page.screenshot({ path: screenshot, timeout: 20000 });
  return { result, seconds, title, firstLayout, firstPaint };
}
