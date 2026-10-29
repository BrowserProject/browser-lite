// Input and page interaction through @browser-lite/core in a real Chromium: typing (also umlauts),
// click, scrolling, popup as a new view, downloads (HTTP, blob:, data:, 404, by extension),
// mailto: and tel: (external-url), sandbox (tel:, download), <a ping> with cookie, CSP report
// without redirect, sendBeacon (preflight, CORS and CSP on redirects), favicon behind a redirect,
// dialogs with the origin, context menu requests, <select>, color and date through the request
// handlers, hover and tooltip, find, zoom, <object>/<embed>, file upload through the native file
// dialog of the host and fullscreen. The test page reports results with console.log
// ("RESULT name=value"), the host page forwards the console of the view.
//
//   node tests/core/input-test.mjs [engine-dir]
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  TIMEOUT,
  buildDir,
  canvasOrigin,
  check,
  collect,
  evalPage,
  finish,
  hostEvents,
  launch,
  openHost,
  screenshot,
  serve,
  startStack,
  timeLimit,
  waitEvent,
  waitFor,
} from '../lib/index.mjs';

timeLimit(TIMEOUT + 240000);

// ------------------------------------------------------------ test pages

const PAGE = `<!doctype html>
<html><head><title>Input test</title>
<style>
  body { margin: 0; font: 16px sans-serif; height: 3000px; }
  #text { position: absolute; left: 20px; top: 20px; width: 300px; height: 30px; font-size: 18px; }
  #button { position: absolute; left: 20px; top: 70px; width: 120px; height: 40px; }
  #popup { position: absolute; left: 20px; top: 130px; }
  #download { position: absolute; left: 20px; top: 170px; }
  #file { position: absolute; left: 20px; top: 210px; }
  #fs { position: absolute; left: 20px; top: 250px; width: 120px; height: 30px; }
  #sel { position: absolute; left: 20px; top: 300px; width: 120px; height: 26px; }
  #hoverlink { position: absolute; left: 20px; top: 345px; }
  #color { position: absolute; left: 20px; top: 380px; width: 60px; height: 30px; }
  #date { position: absolute; left: 20px; top: 430px; width: 160px; height: 26px; }
  #blob { position: absolute; left: 600px; top: 20px; width: 120px; height: 30px; }
  #data { position: absolute; left: 600px; top: 70px; }
  #missing { position: absolute; left: 600px; top: 110px; }
  #mail { position: absolute; left: 600px; top: 150px; }
  #pinglink { position: absolute; left: 600px; top: 190px; }
  #sandboxed, #sandboxed-tel { position: absolute; left: 600px; top: 230px; width: 160px; height: 40px; border: 0; }
  #sandboxed-tel { top: 280px; }
  #objects { position: absolute; left: 20px; top: 1200px; }
</style></head>
<body>
<input id="text" autocomplete="off">
<button id="button">Click</button>
<a id="popup" href="/popup.html" target="_blank">Popup</a>
<a id="download" href="/file.txt">Download</a>
<input id="file" type="file" multiple>
<button id="fs">Fullscreen</button>
<select id="sel"><option value="a">One</option><optgroup label="Group"><option value="b">Two</option><option value="c">Three</option></optgroup></select>
<a id="hoverlink" href="/target" title="A tip">Hover here</a>
<input id="color" type="color" value="#112233">
<input id="date" type="date" value="2026-10-12">
<div id="own-menu" style="position:absolute;left:400px;top:20px;width:150px;height:60px;background:#ddd">own menu</div>
<button id="blob">Save blob</button>
<a id="data" download="data.csv" href="data:text/csv,a%2Cb%0A1%2C2%0A">data:</a>
<a id="missing" download href="/missing.txt">404</a>
<a id="mail" href="mailto:info@example.com?subject=Hello">Mail</a>
<a id="pinglink" href="#pinged" ping="/ping">Ping</a>
<iframe id="sandboxed" sandbox="allow-scripts" srcdoc="<body style='margin:0'><a href='tel:+41111111111' style='position:absolute;left:0;top:0;width:70px;height:40px'>tel</a><a download href='data:text/plain,x' style='position:absolute;left:80px;top:0;width:70px;height:40px'>dl</a>"></iframe>
<iframe id="sandboxed-tel" sandbox="allow-scripts allow-top-navigation-to-custom-protocols" srcdoc="<body style='margin:0'><a href='tel:+41222222222' style='display:block;height:40px'>tel</a>"></iframe>
<div id="objects">
  <object id="o-svg" data="/image.svg" type="image/svg+xml"></object>
  <embed id="o-embed" src="/image.svg">
  <object id="o-html" data="/inner.html"></object>
  <object id="o-gif" data="/dot.gif" type="image/gif"></object>
  <object id="o-flash" data="/movie.swf" type="application/x-shockwave-flash"><span id="fallback">Fallback</span></object>
  <iframe src="/csp.html" width="20" height="20"></iframe>
</div>
<script>
  document.cookie = 'session=42';
  // Like many pages: build a blob, click a link, revoke the address right away
  document.getElementById('blob').addEventListener('click', () => {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob(['Content from the blob\\n'], { type: 'text/plain' }));
    link.download = 'blob.txt';
    link.click();
    URL.revokeObjectURL(link.href);
  });
  addEventListener('load', () => {
    const svg = document.getElementById('o-svg').contentDocument?.documentElement?.localName;
    const embed = document.getElementById('o-embed').getSVGDocument?.()?.documentElement?.localName;
    const html = document.getElementById('o-html').contentDocument?.title;
    const gif = document.getElementById('o-gif');
    const fallback = document.getElementById('fallback').offsetWidth > 0;
    console.log('RESULT objects=' + [svg, embed, html, gif.offsetWidth + 'x' + gif.offsetHeight, fallback].join(','));
  });
  const text = document.getElementById('text');
  text.addEventListener('change', () => console.log('RESULT text=' + text.value));
  text.addEventListener('keydown', (e) => { if (e.key === 'Enter') console.log('RESULT text=' + text.value); });
  document.getElementById('button').addEventListener('click', () => console.log('RESULT click=1'));
  let scrolled = false;
  window.addEventListener('wheel', (e) => console.log('RESULT wheeldelta=' + e.deltaY + ',' + e.wheelDeltaY), { once: true, passive: true });
  window.addEventListener('scroll', () => {
    if (!scrolled && window.scrollY > 100) {
      scrolled = true;
      console.log('RESULT scroll=' + Math.round(window.scrollY));
    }
  });
  document.getElementById('file').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    console.log('RESULT filetypes=' + files.map((f) => f.name.split('.').pop() + ':' + (f.type || '-')).join(','));
    console.log('RESULT fileread=' + (await files[0].text()).trim());
    const form = new FormData();
    for (const file of files)
      form.append('upload', file);
    const response = await fetch('/upload', { method: 'POST', body: form });
    console.log('RESULT upload=' + (await response.text()));
  });
  document.getElementById('own-menu').addEventListener('contextmenu', (e) => {
    e.preventDefault();
    console.log('RESULT ownmenu=1');
  });
  document.getElementById('fs').addEventListener('click', () => {
    console.log('RESULT fsclick=' + document.fullscreenEnabled + ',' + typeof document.documentElement.requestFullscreen);
    document.documentElement.requestFullscreen().then(() => console.log('RESULT fs=ok'), (e) => console.log('RESULT fs=' + e.name));
  });
  document.addEventListener('fullscreenchange', () => {
    console.log(document.fullscreenElement ? 'RESULT fson=1' : 'RESULT fsoff=1');
  });
  const sel = document.getElementById('sel');
  sel.addEventListener('change', () => console.log('RESULT select=' + sel.value));
  const color = document.getElementById('color');
  color.addEventListener('change', () => console.log('RESULT color=' + color.value));
  const date = document.getElementById('date');
  date.addEventListener('change', () => console.log('RESULT date=' + date.value));
  window.addEventListener('resize', () => console.log('RESULT width=' + window.innerWidth));
  console.log('RESULT ready=1');
</script>
</body></html>`;

const POPUP =
  '<!doctype html><title>Popup page</title><p>I am a popup</p><script>console.log("RESULT popup=" + document.title)</script>';

let resolvePing;
const pingArrived = new Promise((resolve) => {
  resolvePing = resolve;
});
const cspRequests = [];
const { url: siteURL } = await serve((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE);
  } else if (req.url === '/popup.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(POPUP);
  } else if (req.url === '/image.svg') {
    res
      .writeHead(200, { 'Content-Type': 'image/svg+xml' })
      .end(
        '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="teal"/></svg>',
      );
  } else if (req.url === '/inner.html') {
    res
      .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      .end('<!doctype html><title>Embedded</title><p>In the object');
  } else if (req.url === '/dot.gif') {
    res
      .writeHead(200, { 'Content-Type': 'image/gif' })
      .end(Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64'));
  } else if (req.url === '/favicon.ico') {
    res.writeHead(301, { Location: '/dot.gif' }).end();
  } else if (req.url === '/csp.html') {
    res
      .writeHead(200, {
        'Content-Type': 'text/html',
        'Content-Security-Policy': "img-src 'none'; report-uri /csp-report",
      })
      .end('<!doctype html><img src="/dot.gif">');
  } else if (req.url === '/csp-report' || req.url === '/csp-target') {
    // Reports follow no redirect (else data and cookies would go to the target)
    cspRequests.push(req.url);
    res.writeHead(307, { Location: '/csp-target' }).end();
  } else if (req.url === '/ping') {
    res.writeHead(307, { Location: '/ping-target' }).end();
  } else if (req.url === '/ping-target' && req.method === 'POST') {
    resolvePing({ cookie: req.headers.cookie || '', pingTo: req.headers['ping-to'] || '' });
    res.writeHead(204).end();
  } else if (req.url === '/beacon-csp.html') {
    res
      .writeHead(200, {
        'Content-Type': 'text/html',
        'Content-Security-Policy': "connect-src 'self'",
      })
      .end(
        '<!doctype html><script>navigator.sendBeacon("/redirect-foreign", "csp"); navigator.sendBeacon("/redirect-own", "own");</script>',
      );
  } else if (req.url === '/redirect-foreign') {
    res.writeHead(307, { Location: `${foreignURL}csp-target` }).end();
  } else if (req.url === '/redirect-own') {
    res.writeHead(307, { Location: '/beacon-own' }).end();
  } else if (req.url === '/beacon-own' && req.method === 'POST') {
    resolveOwnBeacon();
    res.writeHead(204).end();
  } else if (req.url === '/file.txt') {
    res
      .writeHead(200, {
        'Content-Type': 'text/plain',
        'Content-Disposition': 'attachment; filename="greeting.txt"',
      })
      .end('Content of the download\n');
  } else if (req.url === '/archive.zip') {
    res.writeHead(200).end('PK');
  } else if (req.url === '/upload' && req.method === 'POST') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      res
        .writeHead(200, { 'Content-Type': 'text/plain' })
        .end(
          body.includes('Upload content 123') && body.includes('Content-Type: video/mp4')
            ? 'arrived'
            : 'missing',
        );
    });
  } else {
    res.writeHead(404).end();
  }
});

// Foreign origin for sendBeacon (another port, the same cookies). A blob with application/json
// needs a preflight.
const siteOrigin = siteURL.slice(0, -1);
const foreignRequests = [];
let resolveOwnBeacon;
let resolveAllowedBeacon;
const ownBeaconArrived = new Promise((resolve) => {
  resolveOwnBeacon = resolve;
});
const allowedBeaconArrived = new Promise((resolve) => {
  resolveAllowedBeacon = resolve;
});
const { url: foreignURL } = await serve((req, res) => {
  foreignRequests.push(`${req.method} ${req.url}`);
  const cors = {
    'Access-Control-Allow-Origin': siteOrigin,
    'Access-Control-Allow-Credentials': 'true',
  };
  if (req.method === 'OPTIONS' && (req.url === '/allowed' || req.url === '/redirect')) {
    res
      .writeHead(204, {
        ...cors,
        'Access-Control-Allow-Methods': 'POST',
        'Access-Control-Allow-Headers': 'content-type',
      })
      .end();
  } else if (req.method === 'POST' && req.url === '/allowed') {
    resolveAllowedBeacon({ cookie: req.headers.cookie || '', origin: req.headers.origin || '' });
    res.writeHead(204, cors).end();
  } else if (req.method === 'POST' && req.url === '/redirect') {
    res.writeHead(307, { Location: '/redirect-target' }).end();
  } else {
    res.writeHead(204).end();
  }
});

// ------------------------------------------------------- relay + host page

const stack = await startStack({ token: 'input-token-0123456789abcdef' });
const browser = await launch();
const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
const page = await context.newPage();
// Without a fileChooser handler the core uses the native file dialog of the host page
await page.addInitScript(() => {
  window.blTestOptions = { handlers: { fileChooser: undefined } };
});
const results = collect(page, /RESULT (\w+)=(.*?)(\s+\(|$)/);
const result = (key, timeout = 30000) => results.wait(key, timeout);
const host = (expression, arg) => page.evaluate(expression, arg);

await openHost(page, stack.app({ url: siteURL }));
check('page ready', (await result('ready', TIMEOUT)) === '1');

// Position in the canvas of the active view -> position in the window
async function at(x, y) {
  const box = await canvasOrigin(page);
  return [box.x + x, box.y + y];
}

// 1) Click
await page.mouse.click(...(await at(80, 90)));
check('click on a button', (await result('click')) === '1');

// 2) Typing: normal keys (keydown) and text without a key (insertText, like an IME)
await page.mouse.click(...(await at(100, 35)));
await page.keyboard.type('Hello world');
await page.keyboard.insertText(' Grüezi äöü €');
await page.keyboard.press('Backspace');
await page.keyboard.type('!');
await page.keyboard.press('Enter');
const typed = await result('text');
check('typing including umlauts', typed === 'Hello world Grüezi äöü !', JSON.stringify(typed));

// 3) Downloads through the download event of the browser
const hostIndex = () => host(() => window.blHost.downloads.length);
// Clicks at x, y and resolves the finished (or failed) download entry of the host page
async function downloadByClick(x, y) {
  const before = await hostIndex();
  await page.mouse.click(...(await at(x, y)));
  if (!(await waitFor(async () => (await hostIndex()) > before, 30000))) return null;
  await waitFor(
    () =>
      host(
        (i) =>
          window.blHost.downloads[i].text !== null || window.blHost.downloads[i].state === 'error',
        before,
      ),
    30000,
  );
  return host((i) => window.blHost.downloads[i], before);
}
const httpDownload = await downloadByClick(40, 178);
check(
  'download (Content-Disposition: attachment)',
  httpDownload?.filename === 'greeting.txt' &&
    httpDownload.state === 'done' &&
    httpDownload.text === 'Content of the download\n',
  JSON.stringify(httpDownload),
);

// 3b) Downloads without the network: blob: (revoked right away) and data: with download=
const blobDownload = await downloadByClick(660, 35);
check(
  'download blob:',
  blobDownload?.filename === 'blob.txt' && blobDownload.text === 'Content from the blob\n',
  JSON.stringify(blobDownload),
);
const dataDownload = await downloadByClick(615, 78);
check(
  'download data:',
  dataDownload?.filename === 'data.csv' && dataDownload.text === 'a,b\n1,2\n',
  JSON.stringify(dataDownload),
);

// 3c) 404: no file but an error like in Chrome
const missingDownload = await downloadByClick(610, 118);
check(
  'download 404 becomes an error',
  missingDownload?.filename === 'missing.txt' &&
    missingDownload.state === 'error' &&
    /404/.test(missingDownload.error ?? ''),
  JSON.stringify(missingDownload),
);

// 3c2) Without Content-Type the extension counts: an archive becomes a download, not a page
const before = await hostIndex();
await evalPage(page, 'location.href = "/archive.zip"');
await waitFor(async () => (await hostIndex()) > before, 30000);
const zipDownload = await host((i) => window.blHost.downloads[i] ?? null, before);
check(
  'without Content-Type: .zip becomes a download',
  zipDownload?.filename === 'archive.zip',
  JSON.stringify(zipDownload),
);

// 3d) mailto: goes to the host (external-url), the page stays and shows no load error. Without a
// click tel: is dropped silently.
await page.mouse.click(...(await at(610, 158)));
const mail = await waitEvent(page, /^external-url:/, 10000);
check(
  'mailto: to the host (external-url)',
  mail === 'external-url:mailto:info@example.com?subject=Hello',
  String(mail),
);
await evalPage(page, 'location.href = "tel:+41000000000"');
await page.waitForTimeout(1000);
const external = (await hostEvents(page)).filter(
  (e) => e.startsWith('external-url:') || /^commit:./.test(e),
);
check(
  'tel: without a click: nothing opened, no error page',
  external.length === 1,
  external.join(' '),
);

// 3d2) iframe with sandbox="allow-scripts": no tel: to the host, no download (without
// allow-downloads). With allow-top-navigation-to-custom-protocols tel: works after a click.
const downloadsBeforeSandbox = await hostIndex();
await page.mouse.click(...(await at(630, 250)));
await page.mouse.click(...(await at(710, 250)));
await page.mouse.click(...(await at(680, 300)));
await waitFor(
  async () => (await hostEvents(page)).filter((e) => e.startsWith('external-url:')).length > 1,
  10000,
);
await page.waitForTimeout(1500);
const sandboxOpened = (await hostEvents(page))
  .filter((e) => e.startsWith('external-url:'))
  .slice(1);
check(
  'sandbox: tel: only with allow-top-navigation-to-custom-protocols',
  JSON.stringify(sandboxOpened) === '["external-url:tel:+41222222222"]' &&
    results.logs.some((line) => line.includes('external URL from a sandboxed iframe')),
  JSON.stringify(sandboxOpened),
);
check(
  'sandbox: no download without allow-downloads',
  (await hostIndex()) === downloadsBeforeSandbox &&
    results.logs.some((line) => line.includes('Not allowed to download due to sandboxing')),
);

// 3e) <a ping>: with the cookies of the page like in Chrome, also after a redirect
await page.mouse.click(...(await at(610, 198)));
const ping = await Promise.race([
  pingArrived,
  new Promise((resolve) => setTimeout(() => resolve(null), 15000)),
]);
check(
  '<a ping> with cookie after a redirect',
  ping?.cookie === 'session=42' && ping.pingTo === `${siteURL}#pinged`,
  JSON.stringify(ping),
);
check(
  'CSP report follows no redirect',
  cspRequests.length > 0 && !cspRequests.includes('/csp-target'),
  cspRequests.join(' '),
);

// 3e2) sendBeacon to a foreign origin: application/json only after an allowed preflight, then
// with cookie and Origin. A redirect without CORS headers ends, connect-src of the page also
// applies to the target of a redirect.
await page.evaluate(
  (foreign) =>
    window.blTest.eval(`
  const json = () => new Blob(['{}'], { type: 'application/json' });
  navigator.sendBeacon('${foreign}forbidden', json());
  navigator.sendBeacon('${foreign}redirect', json());
  navigator.sendBeacon('${foreign}allowed', json());
  document.body.appendChild(Object.assign(document.createElement('iframe'), { src: '/beacon-csp.html' }));`),
  foreignURL,
);
const within = (promise) =>
  Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(null), 15000))]);
const allowedBeacon = await within(allowedBeaconArrived);
const ownBeacon = await within(ownBeaconArrived.then(() => true));
await page.waitForTimeout(2000);
const foreignLog = foreignRequests.join(' | ');
check(
  'sendBeacon with preflight: cookie and Origin',
  allowedBeacon?.cookie === 'session=42' &&
    allowedBeacon.origin === siteOrigin &&
    foreignRequests.indexOf('OPTIONS /allowed') >= 0 &&
    foreignRequests.indexOf('OPTIONS /allowed') < foreignRequests.indexOf('POST /allowed'),
  `${JSON.stringify(allowedBeacon)} ${foreignLog}`,
);
check(
  'sendBeacon: refused preflight, no POST',
  foreignRequests.includes('OPTIONS /forbidden') && !foreignRequests.includes('POST /forbidden'),
  foreignLog,
);
check(
  'sendBeacon: redirect without CORS headers ends',
  foreignRequests.includes('POST /redirect') &&
    !foreignRequests.some((line) => line.endsWith('/redirect-target')),
  foreignLog,
);
check(
  'sendBeacon: connect-src applies after a redirect',
  ownBeacon === true && !foreignRequests.some((line) => line.endsWith('/csp-target')),
  foreignLog,
);

// 3f) Favicon: /favicon.ico redirects, the icon still reaches the host
const icon = await waitEvent(page, /^icon-image:/, 15000);
check('favicon behind a redirect', icon === 'icon-image:1x1', String(icon));

// 3g) <object>/<embed>: SVG and HTML as frames, GIF as an image, an unknown plugin shows the fallback
const objects = await result('objects');
check('<object>/<embed>', objects === 'svg,svg,Embedded,1x1,true', objects);

// 4) File upload through the native file dialog of the host page
const uploadFile = path.join(buildDir, 'e2e-upload.txt');
mkdirSync(buildDir, { recursive: true });
writeFileSync(uploadFile, 'Upload content 123\n');
// Type by extension like Chrome (File.type, Content-Type in the form)
const uploadFiles = [
  uploadFile,
  ...['mp4', 'csv', 'docx', 'zip'].map((extension) => {
    const file = path.join(buildDir, `e2e-upload.${extension}`);
    writeFileSync(file, 'x');
    return file;
  }),
];
const chooserPromise = page.waitForEvent('filechooser', { timeout: 30000 }).catch(() => null);
await page.mouse.click(...(await at(60, 220)));
const chooser = await chooserPromise;
if (chooser) {
  await chooser.setFiles(uploadFiles);
  const types = await result('filetypes');
  check(
    'file type by extension (File.type)',
    types ===
      'txt:text/plain,mp4:video/mp4,csv:text/csv,docx:application/vnd.openxmlformats-officedocument.wordprocessingml.document,zip:application/zip',
    types,
  );
  check('read the file (FileReader)', (await result('fileread')) === 'Upload content 123');
  check(
    'upload the file (fetch + FormData)',
    (await result('upload')) === 'arrived',
    results.get('upload'),
  );
} else {
  check('file upload', false, 'no file dialog');
}

// 5) Popup (target=_blank) becomes a new view, the host makes it active
await page.mouse.click(...(await at(40, 138)));
const popup = await result('popup');
const viewCount = await host(() => window.blTest.views().length);
const popupEvent = await waitEvent(page, /^new-view:/, 1000);
check(
  'popup as a new view',
  popup === 'Popup page' && viewCount === 2 && popupEvent === 'new-view:1',
  `title ${popup}, ${viewCount} views, ${popupEvent}`,
);
await host(() => window.blHost.select(0));

// 5a) Dialogs: the handler gets the type, the message and the origin of the page
await evalPage(page, 'console.log("RESULT confirm=" + confirm("Really?"))');
const confirmed = await result('confirm');
const dialog = await host(() => window.blHost.dialogs.at(-1));
check(
  'confirm through the handler with the origin',
  confirmed === 'true' &&
    dialog?.type === 'confirm' &&
    dialog.message === 'Really?' &&
    dialog.origin.includes(new URL(siteURL).host),
  JSON.stringify(dialog),
);

// 5b) Right click: the own menu of the page gets the event, no context menu request
const menusBefore = await host(() => window.blHost.contextMenus.length);
await page.mouse.click(...(await at(470, 50)), { button: 'right' });
check('right click: menu of the page', (await result('ownmenu')) === '1');
await page.waitForTimeout(500);
check(
  'right click: no context-menu event',
  (await host(() => window.blHost.contextMenus.length)) === menusBefore,
);

// 5c) Right click on the link: context-menu event with the link
await page.mouse.click(...(await at(40, 138)), { button: 'right' });
await waitFor(
  async () => (await host(() => window.blHost.contextMenus.length)) > menusBefore,
  10000,
);
const menu = await host(() => window.blHost.contextMenus.at(-1));
check(
  'right click on a link: context-menu event with the link',
  menu?.link === `${siteURL}popup.html` && !menu.editable,
  JSON.stringify(menu),
);

// 5d) <select>: the selectPopup handler gets the items with the group, the answer reaches the page
await host(() => {
  window.blHost.selectAnswer = 3;
});
await page.mouse.click(...(await at(60, 312)));
await waitFor(async () => (await host(() => window.blHost.selectRequests.length)) > 0, 10000);
const select = await host(() => window.blHost.selectRequests[0]);
check(
  'select: request with group',
  select?.items.map((item) => item.trim()).join('|') === 'One|Group|Two|Three' &&
    select.labels.join('|') === 'option|group|option|option' &&
    select.selectedIndex === 0,
  JSON.stringify(select),
);
check('select: answer reaches the page', (await result('select')) === 'c', results.get('select'));
results.delete('select');
await host(() => {
  window.blHost.selectAnswer = -1;
});
await page.mouse.click(...(await at(60, 312)));
await waitFor(async () => (await host(() => window.blHost.selectRequests.length)) > 1, 10000);
await page.waitForTimeout(500);
check('select: -1 closes without a choice', !results.has('select'));

// 5e) Link under the mouse: hover event with the address, title as the tooltip
await page.mouse.move(...(await at(40, 352)));
const hover = await waitEvent(page, /^hover:.*\/target$/, 10000);
check('link address (hover event)', hover === `hover:${siteURL}target`, String(hover));
const tooltip = await host(() => window.blTest.view().canvas.title);
check('tooltip (title)', tooltip === 'A tip', JSON.stringify(tooltip));
await page.mouse.move(...(await at(600, 600)));
check(
  'link address goes away (hover event without url)',
  await waitFor(
    async () =>
      (await hostEvents(page)).at(-1) === 'hover:' ||
      (await hostEvents(page)).filter((e) => e.startsWith('hover')).at(-1) === 'hover:',
    10000,
  ),
);

// 5f) Color: colorPicker handler with the value, the answer goes to the page
await host(() => {
  window.blHost.colorAnswer = '#445566';
});
await page.mouse.click(...(await at(50, 395)));
await waitFor(async () => (await host(() => window.blHost.colorRequests.length)) > 0, 10000);
const colorRequest = await host(() => window.blHost.colorRequests[0]);
check('color picker request', colorRequest?.value === '#112233', JSON.stringify(colorRequest));
check('color reaches the page', (await result('color')) === '#445566', results.get('color'));

// 5g) Date: dateTimePicker handler
await host(() => {
  window.blHost.dateAnswer = '2027-03-04';
});
await page.mouse.click(...(await at(165, 443)));
await waitFor(async () => (await host(() => window.blHost.dateRequests.length)) > 0, 10000);
const dateRequest = await host(() => window.blHost.dateRequests[0]);
check(
  'date picker request',
  dateRequest?.type === 'date' && dateRequest.value === '2026-10-12',
  JSON.stringify(dateRequest),
);
check('date reaches the page', (await result('date')) === '2027-03-04', results.get('date'));

// 5h) Find in the page: matches counted
await host(() => window.blTest.view().find('Hover'));
check(
  'find in the page',
  !!(await waitEvent(page, 'find:1', 10000)),
  (await hostEvents(page)).filter((e) => e.startsWith('find')).join(),
);
await host(() => window.blTest.view().stopFind());

// 5i) Zoom: the page gets narrower in CSS pixels; back to 1
results.delete('width');
await host(() => window.blTest.view().setZoom(1.1));
const zoomWidth = await result('width', 10000);
check(
  'zoom',
  Number(zoomWidth) < 950 && (await host(() => window.blTest.view().zoom)) === 1.1,
  `innerWidth ${zoomWidth}`,
);
results.delete('width');
await host(() => window.blTest.view().setZoom(1));
const resetWidth = await result('width', 10000);
check('reset zoom', Number(resetWidth) >= 950, String(resetWidth));

// 6) Scrolling with the mouse wheel; the page reads the host's wheelDelta (Monaco and others
// count notches with it)
await host(() => {
  document.getElementById('view').addEventListener(
    'wheel',
    (e) => {
      window.hostWheel = `${e.deltaY},${e.wheelDeltaY}`;
    },
    { once: true, capture: true },
  );
});
await page.mouse.move(...(await at(500, 400)));
await page.mouse.wheel(0, 600);
const scroll = await result('scroll');
check('scrolling', Number(scroll) > 100, String(scroll));
const pageWheel = await result('wheeldelta', 10000);
const hostWheel = await host(() => window.hostWheel);
check(
  'wheelDelta like the host',
  !!pageWheel && pageWheel === hostWheel,
  `page ${pageWheel}, host ${hostWheel}`,
);

// 6b) Scrolling with the keyboard on the page itself (patch 0063: PageDown/End/Home did nothing)
await page.mouse.wheel(0, -2000);
await evalPage(page, 'document.activeElement?.blur()');
await page.waitForTimeout(500);
for (const [key, name] of [
  ['PageDown', 'keypagedown'],
  ['End', 'keyend'],
  ['Home', 'keyhome'],
]) {
  await page.keyboard.press(key);
  await page.waitForTimeout(800);
  await evalPage(page, `console.log("RESULT ${name}=" + Math.round(scrollY))`);
}
const pageDown = Number(await result('keypagedown'));
const end = Number(await result('keyend'));
check(
  'keyboard scrolling: PageDown, End, Home',
  pageDown > 100 && end >= pageDown && Number(await result('keyhome')) === 0,
  `${pageDown}, ${end}, ${results.get('keyhome')}`,
);

// 7) Fullscreen: the page requests it, the core makes the view container fullscreen; when the
// host ends it (like with Esc), the page notices too
await page.mouse.wheel(0, -2000);
await page.waitForTimeout(500);
await page.mouse.click(...(await at(60, 265)));
const fullscreenClick = await result('fsclick', 10000);
const fullscreen = await result('fs');
const hostFullscreen = await waitFor(
  () => host(() => document.fullscreenElement?.id === 'view'),
  10000,
);
check(
  'fullscreen (requestFullscreen)',
  fullscreen === 'ok' &&
    (await result('fson')) === '1' &&
    hostFullscreen &&
    !!(await waitEvent(page, 'fullscreen:true', 1000)),
  `click: ${fullscreenClick}, page: ${fullscreen}, host: ${hostFullscreen}`,
);
await host(() => document.exitFullscreen().catch(() => {}));
check('ending fullscreen reaches the page', (await result('fsoff')) === '1');

await screenshot(page, 'input');
await browser.close();
finish();
