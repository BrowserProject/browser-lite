// A font uses its preload (patch 0186): `<link rel=preload as=font crossorigin>` loads with an
// Origin header, the font of `@font-face` without one (WebKit loads fonts without CORS), and once
// the preload's response had `Vary: Origin`, an `@font-face` rule that came after it loaded the
// font again, through the network: edition.cnn.com preloads its four fonts like this, its 2 MB
// style sheet comes into the style resolver seconds later, and on a loaded phone the second load
// of each font came seconds after that. Here a page preloads a font the server answers with
// `Vary: Origin, Accept-Language` and adds the rule only after the preload arrived: the font is
// requested once and the text has it.
//
//   node tests/core/font-preload-test.mjs [engine-dir]
import fs from 'node:fs';
import path from 'node:path';
import {
  check,
  collect,
  engineDir,
  finish,
  launch,
  openHost,
  serve,
  startStack,
  timeLimit,
  watchErrors,
} from '../lib/index.mjs';

timeLimit();

// A monospace font of the engine's lazy fonts: its text is wider than the fallback's
const font = fs.readFileSync(path.join(engineDir, 'lazy/fonts/noto/NotoSansMono-Regular.000.ttf'));
const page = `<!doctype html><head>
<link rel="preload" href="/font.ttf" as="font" type="font/ttf" crossorigin>
<style>span { font: 30px serif; }</style></head><body><span id="text">iiiii lllll</span>
<script>
  const text = document.getElementById('text');
  const fallback = text.getBoundingClientRect().width;
  const entry = () => performance.getEntriesByName(new URL('/font.ttf', location.href).href)[0];
  // The rule and the text that takes it come once the preload has arrived
  const use = () => {
    if (!entry()?.responseEnd) return setTimeout(use, 50);
    const style = document.createElement('style');
    style.textContent = '@font-face { font-family: Preloaded; src: url(/font.ttf) format("truetype"); }' +
      ' .web { font-family: Preloaded, serif; }';
    document.head.append(style);
    text.className = 'web';
    document.fonts.load('30px Preloaded').then(() => requestAnimationFrame(() =>
      console.log('RESULT widths=' + fallback + ',' + text.getBoundingClientRect().width)));
  };
  use();
</script>`;

const requests = [];
const { url: siteURL } = await serve((req, res) => {
  if (req.url === '/font.ttf') {
    requests.push(req.headers.origin ? 'with Origin' : 'without Origin');
    res
      .writeHead(200, {
        'Content-Type': 'font/ttf',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'max-age=3000000, immutable',
        Vary: 'Origin, Accept-Language',
      })
      .end(font);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(page);
});

const stack = await startStack({ token: 'font-preload-token-0123456789abcdef', allowLocal: true });
const browser = await launch();
const tab = await browser.newPage({ viewport: { width: 800, height: 600 } });
watchErrors(tab);
const results = collect(tab);
check('host page starts', await openHost(tab, stack.app({ url: siteURL })));
const widths = await results.wait('widths', 30000);
const [fallback, web] = (widths ?? '').split(',').map(Number);
check('the text has the preloaded font', web > fallback, widths);
check(
  'the font is requested once, by its preload',
  requests.length === 1 && requests[0] === 'with Origin',
  requests.join(', '),
);

await browser.close();
finish();
