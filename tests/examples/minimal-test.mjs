// examples/minimal in Chromium with a real engine: copy-engine, vite build, the documented
// `npm run relay` (browser-lite-server through the package), and the preview (COOP/COEP/CORP on
// the engine files, sw.js) runs a page through the relay.
//
//   node tests/examples/minimal-test.mjs [engine-dir]
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import {
  TIMEOUT,
  check,
  engineDir,
  finish,
  freePort,
  launch,
  root,
  runProcess,
  serve,
  startProcess,
  timeLimit,
  watchErrors,
} from '../lib/index.mjs';
import { RED_PAGE, rendersRed } from './screen.mjs';

timeLimit();

const minimalDir = path.join(root, 'examples', 'minimal');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
// Only what the test creates is removed at the end, not an engine copy or build of the developer
const outputs = ['public', 'public/engine', 'dist']
  .map((dir) => path.join(minimalDir, dir))
  .filter((dir) => !existsSync(dir));

const pages = await serve((_req, res) =>
  res.writeHead(200, { 'Content-Type': 'text/html' }).end(RED_PAGE),
);
const browser = await launch();
try {
  // Like `npm run copy-engine -w ...` in the repository root with a relative ENGINE_DIR
  await runProcess(process.execPath, [path.join(minimalDir, 'scripts', 'copy-engine.mjs')], {
    cwd: minimalDir,
    env: { ...process.env, INIT_CWD: root, ENGINE_DIR: path.relative(root, engineDir) || '.' },
  });
  const vite = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
  let built = true;
  await runProcess(process.execPath, [vite, 'build'], { cwd: minimalDir }).catch((error) => {
    built = false;
    console.log(`   ${error.message}`);
  });
  check('minimal: vite build', built);
  if (!built) throw new Error('no build');

  const relayPort = await freePort();
  await startProcess('relay', npm, ['run', 'relay', '--silent'], {
    cwd: minimalDir,
    env: {
      ...process.env,
      PORT: String(relayPort),
      HOST: '127.0.0.1',
      RELAY_ALLOW_LOCAL: '1',
      RELAY_TOKEN: '',
      RELAY_SECRET: '',
    },
    ready: /listening/i,
  });
  check('minimal: npm run relay starts browser-lite-server', true);
  const previewPort = await freePort();
  await startProcess(
    'preview',
    process.execPath,
    [vite, 'preview', '--host', '127.0.0.1', '--port', String(previewPort), '--strictPort'],
    {
      cwd: minimalDir,
      env: { ...process.env, RELAY_URL: `http://127.0.0.1:${relayPort}` },
      ready: new RegExp(String(previewPort)),
    },
  );
  const PREVIEW = `http://localhost:${previewPort}`;
  const engineJs = await fetch(`${PREVIEW}/engine/engine.js`);
  check(
    'minimal: preview serves engine.js with COOP/COEP/CORP',
    engineJs.ok &&
      engineJs.headers.get('cross-origin-embedder-policy') === 'require-corp' &&
      engineJs.headers.get('cross-origin-opener-policy') === 'same-origin' &&
      engineJs.headers.get('cross-origin-resource-policy') === 'same-origin',
    `${engineJs.status} ${engineJs.headers.get('cross-origin-embedder-policy')}`,
  );
  const swFiles = await Promise.all(
    ['sw.js', 'media-sw.js'].map((file) => fetch(`${PREVIEW}/${file}`).then((r) => r.ok)),
  );
  check('minimal: sw.js and media-sw.js in the build', swFiles.every(Boolean));

  const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  const page = await context.newPage();
  watchErrors(page);
  await page.goto(`${PREVIEW}/?${new URLSearchParams({ url: pages.url })}`);
  check(
    'minimal: title event reaches document.title',
    await page
      .waitForFunction(() => document.title === 'Example page', undefined, { timeout: TIMEOUT })
      .then(
        () => true,
        () => false,
      ),
    (await page.locator('#message').textContent()) ?? '',
  );
  check('minimal: page renders', await rendersRed(page.locator('#view')));
  await context.close();
} catch (error) {
  check('test ran through', false, error.message);
} finally {
  await browser.close();
  pages.server.close();
  for (const dir of outputs) await rm(dir, { recursive: true, force: true });
}
finish();
