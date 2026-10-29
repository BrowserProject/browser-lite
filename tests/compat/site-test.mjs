// Loads real sites from the internet in browser-lite (core test host page in Chromium, local relay
// like on the server) and stores a screenshot per site. Needs internet access. Informational.
//
//   node tests/compat/site-test.mjs [engine-dir] [https://example.com/ ...]
//
// Without URLs: all of sites.txt. Result per site: title, load time, error. Screenshots in
// build/sites/ (name from host, path and query, for example www.google.com_maps.png).
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { BROWSER, SWIFTSHADER, launch as launchChromium, root, startStack } from '../lib/index.mjs';

const args = process.argv.slice(2);
let engineDir = path.join(root, 'build', 'webcore', 'bin');
if (args[0] && !/^[a-z][a-z0-9+.-]*:/i.test(args[0])) engineDir = path.resolve(args.shift());
const sites = args.length
  ? args
  : readFileSync(new URL('sites.txt', import.meta.url), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
const TIMEOUT = Number(process.env.SITE_TIMEOUT || 120000);
const extraCA = process.env.SITE_EXTRA_CA ? readFileSync(process.env.SITE_EXTRA_CA, 'utf8') : null;
const outDir = path.join(root, 'build', 'sites');
mkdirSync(outDir, { recursive: true });

// A real relay like on the server (without RELAY_ALLOW_LOCAL)
const stack = await startStack({
  token: 'site-token-0123456789abcdef',
  allowLocal: false,
  engine: engineDir,
});
// SwiftShader, so WebGL of the pages works without a GPU too (headless, CI)
const launch = () =>
  launchChromium({
    args: [
      ...SWIFTSHADER,
      ...(process.env.SITE_CHROME_ARGS ? process.env.SITE_CHROME_ARGS.split(' ') : []),
    ],
  });
let browser = await launch();
// A promise with a time limit (page.evaluate has none and hangs when the page blocks)
const within = (promise, ms, what) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(what)), ms)),
  ]);

let failed = 0;
const rows = [];

async function checkSite(site, page, log) {
  // Optional own CA (for example with a TLS proxy in between): SITE_EXTRA_CA=file.pem
  if (extraCA)
    await page.addInitScript((pem) => {
      window.blTestOptions = { engine: { extraCA: pem } };
    }, extraCA);
  page.on('console', (msg) => log.push(msg.text()));
  // SITE_DEBUG=1: record the engine log (printed only on problems)
  // SITE_ENV=NAME=value,...: environment of the engine (to compare switches)
  const params = {
    url: site,
    services: 'default,webrtc',
    ...(process.env.SITE_DEBUG ? { log: '1' } : {}),
    ...(process.env.SITE_ENV ? { env: process.env.SITE_ENV } : {}),
  };
  const started = Date.now();
  await page.goto(stack.app(params));
  // First visible layout of the page and the first frame afterwards (the engine reports
  // "first-layout" and "first-paint")
  let firstLayout = '-';
  let firstPaint = '-';
  page
    .waitForFunction(() => window.blTest?.flags.firstLayout === true, null, {
      timeout: TIMEOUT,
      polling: 100,
    })
    .then(() => {
      firstLayout = ((Date.now() - started) / 1000).toFixed(1);
    })
    .catch(() => {});
  page
    .waitForFunction(() => window.blTest?.flags.firstPaint === true, null, {
      timeout: TIMEOUT,
      polling: 100,
    })
    .then(() => {
      firstPaint = ((Date.now() - started) / 1000).toFixed(1);
    })
    .catch(() => {});
  let result = 'ok';
  try {
    // Done when the page loaded or an error page or a load error came
    await page.waitForFunction(
      () =>
        window.blTest?.flags.loaded === true ||
        !!window.blHost?.events.some((e) => /^commit:./.test(e) || e.startsWith('error:')),
      null,
      { timeout: TIMEOUT, polling: 250 },
    );
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
  await page.waitForTimeout(Number(process.env.SITE_WAIT || 1500));
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
    const marker = `SITECHECK${Date.now()}`;
    await within(
      page.evaluate(
        (m) =>
          window.blTest.eval(
            `console.log("${m} " + JSON.stringify((document.body ? document.body.innerText : '').trim().slice(0, 200)))`,
          ),
        marker,
      ),
      10000,
      'Text',
    ).catch(() => {});
    await page.waitForTimeout(1000);
    // Log of the page: '[page N] SITECHECK... "<text>"'
    const line = log.find((l) => l.includes(marker));
    const text = line
      ? line.slice(line.indexOf(marker) + marker.length + 1).replace(/ \(.*\)$/, '')
      : null;
    if (text !== null && text.length < 200) result = `almost empty page: ${text}`;
  }
  const { hostname, pathname, search } = new URL(site);
  const name =
    (hostname + pathname + search)
      .replace(/[^a-zA-Z0-9.-]+/g, '_')
      .replace(/_+$/, '')
      .slice(0, 100) || 'site';
  const file = path.join(outDir, `${name}.png`);
  await page.screenshot({ path: file, timeout: 20000 });
  return { result, seconds, title, firstLayout, firstPaint };
}

const printLog = (log, all) =>
  console.log(
    (all ? log : [...log.slice(0, 40), '...', ...log.slice(-20)]).map((l) => '    ' + l).join('\n'),
  );

// On a hang: where is the main thread of the host page? (stack through the debugger protocol)
async function mainThreadStack(cdp) {
  try {
    const paused = new Promise((resolve) => cdp.once('Debugger.paused', resolve));
    await within(cdp.send('Debugger.pause'), 10000, 'pause');
    const event = await within(paused, 10000, 'paused');
    return event.callFrames
      .slice(0, 30)
      .map(
        (frame) =>
          `${frame.functionName || '(anon)'} ${frame.url.split('/').pop()}:${frame.location.lineNumber}`,
      );
  } catch (e) {
    return [`(no stack: ${e.message})`];
  }
}

for (const site of sites) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  // The main thread's stack of a hanging page: only Chromium has CDP
  const cdp = BROWSER === 'chromium' ? await page.context().newCDPSession(page) : null;
  await cdp?.send('Debugger.enable').catch(() => {});
  const log = [];
  let outcome;
  try {
    // A hard limit per site: a blocked page must not hold up the whole run
    outcome = await within(checkSite(site, page, log), TIMEOUT + 90000, 'page hangs');
  } catch (e) {
    outcome = {
      result: `hangs (${e.message})`,
      seconds: '-',
      title: '',
      firstLayout: '-',
      firstPaint: '-',
    };
    if (cdp) log.push('Stack of the main thread:', ...(await mainThreadStack(cdp)));
  }
  const { result, seconds, title, firstLayout, firstPaint } = outcome;
  if (result !== 'ok') failed++;
  console.log(
    `${result === 'ok' ? 'ok  ' : 'FAIL'} ${site} (${seconds} s, first layout ${firstLayout} s, first paint ${firstPaint} s) title: "${title}" ${result === 'ok' ? '' : result}`,
  );
  rows.push(
    `| ${site} | ${result === 'ok' ? 'loaded' : 'error'} | ${firstLayout} s | ${firstPaint} s | ${seconds} s | ${title.replace(/\|/g, '/').slice(0, 60)} |`,
  );
  // An empty page (no title) or an error: show the log, so one sees what happened
  const blank = !title;
  if (result !== 'ok' || blank || process.env.SITE_LOG)
    printLog(
      process.env.SITE_LOG === 'all' || result !== 'ok' ? log.slice(-80) : log,
      process.env.SITE_LOG === 'all' || result !== 'ok',
    );
  try {
    await within(page.close(), 10000, 'close');
  } catch {
    // The page no longer reacts: a new browser for the rest
    await within(browser.close(), 10000, 'browser.close').catch(() => {});
    browser = await launch();
  }
}

// Compatibility list for the GitHub summary
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    [
      '### Compatibility (real sites)',
      '',
      '| Site | State | First layout | First paint | Loaded | Title |',
      '|---|---|---|---|---|---|',
      ...rows,
      '',
    ].join('\n') + '\n',
  );
}

await browser.close();
process.exit(failed ? 1 : 0);
