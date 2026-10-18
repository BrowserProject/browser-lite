// Parity with Chromium: loads tests/fixtures/features.html once directly in the host Chromium and
// once in browser-lite (core with the default services and webrtc) and compares which features
// are there. Output: "x of y like Chromium", the differences by area and a Markdown report
// (PARITY_REPORT=file). Fails only when a feature of parity-baseline.txt is missing (regression).
// PARITY_UPDATE=1 writes the list again.
//
//   node tests/core/parity-test.mjs [engine-dir]
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import {
  TIMEOUT,
  VERBOSE,
  check,
  finish,
  launch,
  root,
  serve,
  startStack,
  timeLimit,
} from '../lib/index.mjs';

const baselineFile = path.join(root, 'tests', 'core', 'parity-baseline.txt');
timeLimit(2 * TIMEOUT + 60000);

const PAGE = readFileSync(path.join(root, 'tests', 'fixtures', 'features.html'));
const { server: site, url: siteURL } = await serve((req, res) =>
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE),
);

// Collects "FEATURE name=value" from the console until "FEATURE done" comes
async function collect(page, load) {
  const results = new Map();
  let done;
  const finished = new Promise((r) => {
    done = r;
  });
  page.on('console', (msg) => {
    if (VERBOSE) console.log('   ', msg.text().slice(0, 200));
    const match = /FEATURE ([\w:.-]+)=(\S+)/.exec(msg.text());
    if (!match) return;
    if (match[1] === 'done') done();
    else results.set(match[1], match[2] === '1');
  });
  await load();
  await Promise.race([finished, new Promise((r) => setTimeout(r, TIMEOUT))]);
  return results;
}

// Reference: the full Chromium (not the headless shell, it lacks some APIs)
let reference;
{
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chromium' });
  } catch (e) {
    browser = await chromium.launch();
  }
  const page = await browser.newPage();
  reference = await collect(page, () => page.goto(siteURL));
  await browser.close();
}

const stack = await startStack({ token: 'parity-token-0123456789abcdef' });
let ours;
{
  const browser = await launch();
  const page = await browser.newPage();
  ours = await collect(page, () =>
    page.goto(stack.app({ url: siteURL, services: 'default,webrtc' })),
  );
  await browser.close();
}
site.close();

if (!reference.size || !ours.size) {
  console.log(`FAIL no results (Chromium ${reference.size}, browser-lite ${ours.size})`);
  process.exit(1);
}

// Comparison: only what Chromium can do counts
const names = [...reference.keys()];
const chromiumHas = names.filter((n) => reference.get(n));
const same = chromiumHas.filter((n) => ours.get(n));
const missing = chromiumHas.filter((n) => !ours.get(n));
const extra = names.filter((n) => !reference.get(n) && ours.get(n));
const percent = ((100 * same.length) / chromiumHas.length).toFixed(1);
console.log(`PARITY ${same.length} of ${chromiumHas.length} features like Chromium (${percent} %)`);

const byArea = new Map();
for (const name of missing) {
  const area = name.split(':')[0];
  byArea.set(area, [...(byArea.get(area) || []), name.slice(area.length + 1)]);
}
for (const [area, list] of byArea)
  console.log(`  missing ${area} (${list.length}): ${list.join(', ')}`);
if (extra.length) console.log(`  only browser-lite: ${extra.join(', ')}`);

if (process.env.PARITY_REPORT) {
  const lines = [
    '### Parity with Chromium',
    '',
    `**${same.length} of ${chromiumHas.length}** features like Chromium (${percent} %)`,
    '',
  ];
  for (const [area, list] of byArea) lines.push(`- missing \`${area}\`: ${list.join(', ')}`);
  writeFileSync(process.env.PARITY_REPORT, lines.join('\n') + '\n');
}

// Regressions against the stored list
const present = names.filter((n) => ours.get(n)).sort();
if (process.env.PARITY_UPDATE || !existsSync(baselineFile)) {
  writeFileSync(
    baselineFile,
    `# Features browser-lite already has (tests/core/parity-test.mjs, PARITY_UPDATE=1)\n${present.join('\n')}\n`,
  );
  console.log(`List written again: ${present.length} features`);
} else {
  const baseline = readFileSync(baselineFile, 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#'));
  for (const name of baseline) {
    if (!ours.get(name)) check(`regression: ${name} worked before`, false);
  }
  const added = present.filter((n) => !baseline.includes(n));
  if (added.length) console.log(`  new (PARITY_UPDATE=1 to store): ${added.join(', ')}`);
}
finish();
