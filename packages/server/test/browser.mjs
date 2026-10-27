// Compression Dictionary Transport with headless Chromium (playwright from the workspace): the CLI
// serves engine/<old>/, Chromium keeps its files as dictionaries, then engine/<new>/ comes as
// the deltas of tools/engine-deltas.mjs (#244).
//   npm run build && node packages/server/test/browser.mjs
// Not part of `npm test`, which runs without a browser.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startCli, stopCli } from './helpers.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
let site;
let cli;
let browser;

// Two versions of a 4 MB file that differ in a few places, like two engine builds
const OLD = crypto.randomBytes(4 * 1024 * 1024);
const NEW = Buffer.from(OLD);
for (let i = 0; i < 64; i++) NEW.writeUInt32LE(i, i * 65536);

before(async () => {
  site = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-dictionary-test-'));
  fs.writeFileSync(path.join(site, 'index.html'), '<!doctype html>dictionary');
  for (const [version, data] of [
    ['old', OLD],
    ['new', NEW],
  ]) {
    fs.mkdirSync(path.join(site, 'engine', version), { recursive: true });
    fs.writeFileSync(path.join(site, 'engine', version, 'engine.wasm'), data);
  }
  execFileSync(process.execPath, [
    path.join(repo, 'tools/engine-deltas.mjs'),
    path.join(site, 'engine/new'),
    path.join(site, 'engine/old'),
  ]);
  cli = await startCli({ SITE_DIR: site });
  browser = await chromium.launch(
    process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
  );
});
after(async () => {
  await browser?.close();
  if (cli) await stopCli(cli);
  fs.rmSync(site, { recursive: true, force: true });
});

test('the new engine file comes as a delta against the old one', async () => {
  const page = await browser.newPage();
  // localhost is a secure context, which dictionaries need
  await page.goto(`http://localhost:${cli.port}/`);
  const result = await page.evaluate(async () => {
    const load = async (url) => {
      const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
      const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      const entry = performance.getEntriesByName(new URL(url, location.href).href).at(-1);
      return {
        hash: Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join(''),
        transfer: entry.transferSize,
      };
    };
    const old = await load('/engine/old/engine.wasm');
    return { old, next: await load('/engine/new/engine.wasm') };
  });
  const sha = (data) => crypto.createHash('sha256').update(data).digest('hex');
  assert.equal(result.old.hash, sha(OLD));
  assert.equal(result.next.hash, sha(NEW), 'the delta decodes to the new file');
  assert.ok(result.old.transfer > 4_000_000, `old file whole (${result.old.transfer})`);
  assert.ok(result.next.transfer < 100_000, `new file as delta (${result.next.transfer})`);
  await page.close();
});
