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
import { checkSite, within } from './site-check.mjs';

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
// Optional own CA (for example with a TLS proxy in between): SITE_EXTRA_CA=file.pem
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
// A new host browser for the rest of the run: one host crash (for example under memory pressure)
// must not end the run
async function relaunch(reason) {
  console.log(`  (${reason}: a new host browser for the rest)`);
  await within(browser.close(), 10000, 'browser.close').catch(() => {});
  browser = await launch();
}

let failed = 0;
const rows = [];

// SITE_DEBUG=1: record the engine log (printed only on problems)
// SITE_ENV=NAME=value,...: environment of the engine (to compare switches)
const params = {
  services: 'default,webrtc',
  ...(process.env.SITE_DEBUG ? { log: '1' } : {}),
  ...(process.env.SITE_ENV ? { env: process.env.SITE_ENV } : {}),
};

// Screenshot file of a site: name from host, path and query
function screenshotFile(site) {
  const { hostname, pathname, search } = new URL(site);
  const name =
    (hostname + pathname + search)
      .replace(/[^a-zA-Z0-9.-]+/g, '_')
      .replace(/_+$/, '')
      .slice(0, 100) || 'site';
  return path.join(outDir, `${name}.png`);
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
  // A closed page resolves page.close() even when the browser died with it, so look here
  if (!browser.isConnected()) await relaunch('the host browser died');
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  // The main thread's stack of a hanging page: only Chromium has CDP
  const cdp = BROWSER === 'chromium' ? await page.context().newCDPSession(page) : null;
  await cdp?.send('Debugger.enable').catch(() => {});
  const log = [];
  let outcome;
  try {
    // A hard limit per site: a blocked page must not hold up the whole run
    outcome = await within(
      checkSite(page, {
        stack,
        site,
        timeout: TIMEOUT,
        settle: Number(process.env.SITE_WAIT || 1500),
        params,
        screenshot: screenshotFile(site),
        extraCA,
        log,
      }),
      TIMEOUT + 90000,
      'page hangs',
    );
  } catch (e) {
    const died = !browser.isConnected();
    outcome = {
      result: died ? `host browser died (${e.message})` : `hangs (${e.message})`,
      seconds: '-',
      title: '',
      firstLayout: '-',
      firstPaint: '-',
    };
    if (cdp && !died) log.push('Stack of the main thread:', ...(await mainThreadStack(cdp)));
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
    await relaunch('the page no longer reacts');
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
