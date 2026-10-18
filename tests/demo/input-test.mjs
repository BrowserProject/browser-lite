// Input and page interaction in the demo UI (the engine side is tests/core/input-test.mjs): native
// downloads and the status line of a failed one, mailto: to the host browser, popups as tabs,
// dialogs with the origin, suppressed in background tabs and limited in bursts, the context menu
// of the ui package, the <select> popup (mouse, keyboard, Esc), the link status bubble and the
// tooltip, the hidden color and date inputs of the host, the find bar, zoom shortcuts, Ctrl +
// mouse wheel with the zoom indicator and fullscreen of the page area.
//
//   node tests/demo/input-test.mjs [engine-dir]
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  TIMEOUT,
  buildDir,
  canvasOrigin,
  check,
  collect,
  finish,
  launch,
  screenshot,
  serve,
  startStack,
  timeLimit,
} from '../lib/index.mjs';

timeLimit(TIMEOUT + 240000);

const PAGE = `<!doctype html>
<html><head><title>Input test</title>
<style>
  body { margin: 0; font: 16px sans-serif; height: 3000px; }
  #popup { position: absolute; left: 20px; top: 130px; }
  #download { position: absolute; left: 20px; top: 170px; }
  #fs { position: absolute; left: 20px; top: 250px; width: 120px; height: 30px; }
  #sel { position: absolute; left: 20px; top: 300px; width: 120px; height: 26px; }
  #hoverlink { position: absolute; left: 20px; top: 345px; }
  #color { position: absolute; left: 20px; top: 380px; width: 60px; height: 30px; }
  #date { position: absolute; left: 20px; top: 430px; width: 160px; height: 26px; }
  #missing { position: absolute; left: 600px; top: 110px; }
  #mail { position: absolute; left: 600px; top: 150px; }
  #map { position: absolute; left: 600px; top: 400px; width: 150px; height: 100px; background: rgb(255, 160, 0); }
</style></head>
<body>
<a id="popup" href="/popup.html" target="_blank">Popup</a>
<a id="download" href="/file.txt">Download</a>
<button id="fs">Fullscreen</button>
<select id="sel"><option value="a">One</option><optgroup label="Group"><option value="b">Two</option><option value="c">Three</option></optgroup></select>
<a id="hoverlink" href="/target" title="A tip">Hover here</a>
<input id="color" type="color" value="#112233">
<input id="date" type="date" value="2026-10-12">
<div id="own-menu" style="position:absolute;left:400px;top:20px;width:150px;height:60px;background:#ddd">own menu</div>
<a id="missing" download href="/missing.txt">404</a>
<a id="mail" href="mailto:info@example.com?subject=Hello">Mail</a>
<div id="map"></div>
<script>
  document.getElementById('own-menu').addEventListener('contextmenu', (e) => {
    e.preventDefault();
    console.log('RESULT ownmenu=1');
  });
  document.getElementById('fs').addEventListener('click', () => {
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
  // A "map" zooms itself with Ctrl + wheel
  let mapZooms = 0;
  document.getElementById('map').addEventListener('wheel', (e) => {
    if (e.ctrlKey) {
      e.preventDefault();
      console.log('RESULT mapzoom=' + ++mapZooms);
    }
  }, { passive: false });
  console.log('RESULT ready=1');
</script>
</body></html>`;

const POPUP =
  '<!doctype html><title>Popup page</title><p>I am a popup</p><script>console.log("RESULT popup=" + document.title)</script>';

const { url: siteURL } = await serve((req, res) => {
  if (req.url === '/') res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE);
  else if (req.url === '/popup.html')
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(POPUP);
  else if (req.url === '/file.txt')
    res
      .writeHead(200, {
        'Content-Type': 'text/plain',
        'Content-Disposition': 'attachment; filename="greeting.txt"',
      })
      .end('Content of the download\n');
  else res.writeHead(404).end();
});

const stack = await startStack({ app: 'demo', token: 'input-token-0123456789abcdef' });
const browser = await launch();
const context = await browser.newContext({
  viewport: { width: 1000, height: 700 },
  acceptDownloads: true,
});
const page = await context.newPage();
const results = collect(page, /RESULT (\w+)=(.*?)(\s+\(|$)/);
const result = (key, timeout = 30000) => results.wait(key, timeout);

await page.goto(stack.app({ url: siteURL }));
check('page ready', (await result('ready', TIMEOUT)) === '1');

// Position in the canvas of the active tab -> position in the window
async function at(x, y) {
  const box = await canvasOrigin(page);
  return [box.x + x, box.y + y];
}

// 1) Download (Content-Disposition: attachment): the demo saves it with the host browser
const downloadPromise = page.waitForEvent('download', { timeout: 30000 }).catch(() => null);
await page.mouse.click(...(await at(40, 178)));
const download = await downloadPromise;
if (download) {
  const file = path.join(buildDir, 'e2e-download.txt');
  await download.saveAs(file);
  check(
    'download saved by the host browser',
    download.suggestedFilename() === 'greeting.txt' &&
      readFileSync(file, 'utf8') === 'Content of the download\n',
    download.suggestedFilename(),
  );
} else {
  check('download saved by the host browser', false, 'no download event');
}

// 2) 404: no file, but an error in the status line like in Chrome
let missingDownload = false;
const onMissing = () => {
  missingDownload = true;
};
page.on('download', onMissing);
await page.mouse.click(...(await at(610, 118)));
const missingStatus = await page
  .waitForFunction(
    () => document.getElementById('status').textContent.startsWith('Download failed'),
    null,
    { timeout: 15000 },
  )
  .then(
    () => page.evaluate(() => document.getElementById('status').textContent),
    () => null,
  );
page.off('download', onMissing);
check(
  'download 404 shows an error',
  missingStatus === 'Download failed: missing.txt (HTTP 404)' && !missingDownload,
  String(missingStatus),
);

// 3) mailto: goes to the host browser (window.open with noopener), the page stays without a load
// error
await page.evaluate(() => {
  window.__opened = [];
  window.open = (...args) => {
    window.__opened.push(args);
    return null;
  };
});
await page.mouse.click(...(await at(610, 158)));
const opened = await page
  .waitForFunction(() => window.__opened.length > 0, null, { timeout: 10000 })
  .then(
    () => page.evaluate(() => window.__opened[0]),
    () => null,
  );
check(
  'mailto: to the host browser',
  opened?.[0] === 'mailto:info@example.com?subject=Hello' &&
    opened?.[1] === '_blank' &&
    opened?.[2] === 'noopener',
  JSON.stringify(opened),
);
const status = await page.evaluate(() => document.getElementById('status').textContent);
check('mailto: no error in the status line', !status.startsWith('Error'), status);

// 4) Popup (target=_blank) becomes a new tab
await page.mouse.click(...(await at(40, 138)));
const popup = await result('popup');
const tabCount = await page.evaluate(() => document.querySelectorAll('#tab-list .tab').length);
check(
  'popup as a new tab',
  popup === 'Popup page' && tabCount === 2,
  `title ${popup}, ${tabCount} tabs`,
);
await page.click('#tab-list .tab:first-child .title');

// 5) Dialogs: with the origin of the page; from a background tab answered right away without a
// dialog
await page.evaluate(() => {
  window.__dialogs = [];
  window.confirm = (text) => {
    window.__dialogs.push(text);
    return true;
  };
  window.alert = (text) => {
    window.__dialogs.push(text);
  };
});
await page.evaluate(() =>
  window.blTest.eval('console.log("RESULT confirm=" + confirm("Really?"))'),
);
const confirmed = await result('confirm');
const dialogs = await page.evaluate(() => window.__dialogs);
check(
  'confirm with the origin',
  confirmed === 'true' &&
    dialogs.length === 1 &&
    dialogs[0] === `${new URL(siteURL).host} says:\n\nReally?`,
  JSON.stringify(dialogs),
);
await page.evaluate(() =>
  window.blTest.eval(
    'setTimeout(() => console.log("RESULT bgalert=" + alert("Background")), 2000)',
  ),
);
await page.click('#tab-list .tab:nth-child(2) .title');
const backgroundAlert = await result('bgalert');
check(
  'alert from a background tab without a dialog',
  backgroundAlert === 'undefined' && (await page.evaluate(() => window.__dialogs.length)) === 1,
  String(backgroundAlert),
);
// A marker at the tab until it is in front again
const dialogMarker = (n) =>
  page.evaluate(
    (n) => !document.querySelector(`#tab-list .tab:nth-child(${n}) .dialog-blocked`).hidden,
    n,
  );
check('suppressed dialog: marker at the background tab', await dialogMarker(1));
await page.click('#tab-list .tab:first-child .title');
check('suppressed dialog: marker gone when the tab is in front', !(await dialogMarker(1)));

// 6) Many dialogs in a short time: after three the demo asks once whether the page may show more.
// No blocks the tab, a new page frees it again. In the popup tab, the page here stays.
await page.click('#tab-list .tab:nth-child(2) .title');
await page.evaluate(() => {
  window.__dialogs = [];
  window.alert = (text) => {
    window.__dialogs.push(text);
  };
  window.confirm = (text) => {
    window.__dialogs.push(text);
    return !text.includes('many dialogs');
  };
});
await page.evaluate(() =>
  window.blTest.eval(
    'for (let i = 0; i < 6; i++) alert("Loop " + i); console.log("RESULT loopdone=1")',
  ),
);
await result('loopdone');
const loopDialogs = await page.evaluate(() =>
  window.__dialogs.map((text) => text.split('\n').pop()),
);
check(
  'dialog loop: three dialogs, one question, then blocked',
  loopDialogs.length === 4 &&
    loopDialogs[2] === 'Loop 2' &&
    loopDialogs[3].includes('is showing many dialogs'),
  JSON.stringify(loopDialogs),
);
check('dialog loop: marker at the blocked tab', await dialogMarker(2));
results.delete('popup');
await page.evaluate(() => window.blTest.eval('location.reload()'));
await result('popup');
await page.evaluate(() =>
  window.blTest.eval('alert("After the reload"); console.log("RESULT reloaddone=1")'),
);
await result('reloaddone');
check(
  'dialog loop: a new page frees the tab',
  (await page.evaluate(() => window.__dialogs.at(-1))).endsWith('After the reload') &&
    !(await dialogMarker(2)),
);
await page.click('#tab-list .tab:first-child .title');

// 7) Right click: the own menu of the page gets the event, our menu stays closed
await page.mouse.click(...(await at(470, 50)), { button: 'right' });
check('right click: menu of the page', (await result('ownmenu')) === '1');
await page.waitForTimeout(500);
check(
  'right click: our menu stays closed',
  await page.evaluate(() => !document.querySelector('.bl-context-menu')),
);

// 8) Right click on the link: our menu, "Open link in new tab"
await page.mouse.click(...(await at(40, 138)), { button: 'right' });
const menuItem = page.locator('.bl-context-menu button[data-bl-item=open-link]', {
  hasText: 'Open link in new tab',
});
const menuShown = await menuItem.waitFor({ timeout: 10000 }).then(
  () => true,
  () => false,
);
check('right click on a link: menu', menuShown);
if (menuShown) {
  await menuItem.click();
  await page
    .waitForFunction(() => document.querySelectorAll('#tab-list .tab').length === 3, null, {
      timeout: 30000,
    })
    .catch(() => {});
  check(
    'link opened in a new tab',
    (await page.evaluate(() => document.querySelectorAll('#tab-list .tab').length)) === 3,
  );
  await page.click('#tab-list .tab:first-child .title');
}

// 9) <select>: a click opens our list, the choice reaches the page
const selectPopup = async () => {
  await page.mouse.click(...(await at(60, 312)));
  return page.waitForSelector('.bl-select-popup .bl-option', { timeout: 10000 }).then(
    () => true,
    () => false,
  );
};
let popupShown = await selectPopup();
const popupRows = await page.evaluate(() =>
  [...document.querySelectorAll('.bl-select-popup > div')]
    .map((d) => `${d.classList[0].replace('bl-', '')}:${d.textContent.trim()}`)
    .join('|'),
);
check(
  'select: list opens',
  popupShown && popupRows === 'option:One|group:Group|option:Two|option:Three',
  popupRows,
);
if (popupShown) {
  await page.locator('.bl-select-popup .bl-option', { hasText: 'Three' }).click();
  check('select: choice with the mouse', (await result('select')) === 'c', results.get('select'));
}
results.delete('select');
popupShown = await selectPopup();
await page.keyboard.press('ArrowUp');
await page.keyboard.press('Enter');
check(
  'select: choice with the keyboard',
  popupShown && (await result('select')) === 'b',
  results.get('select'),
);
results.delete('select');
popupShown = await selectPopup();
await page.keyboard.press('Escape');
await page.waitForTimeout(500);
check(
  'select: Esc closes without a choice',
  popupShown &&
    !results.has('select') &&
    (await page.evaluate(() => !document.querySelector('.bl-select-popup'))),
);

// 10) Link under the mouse: address bottom left, title as the tooltip
await page.mouse.move(...(await at(40, 352)));
const linkShown = await page
  .waitForFunction(
    () => {
      const status = document.querySelector('.bl-link-status');
      return status && !status.hidden && status.textContent.endsWith('/target');
    },
    null,
    { timeout: 10000 },
  )
  .then(
    () => true,
    () => false,
  );
check('link address bottom left', linkShown);
const tooltip = await page.evaluate(
  () =>
    [...document.querySelectorAll('canvas[data-bl-view]')].find((c) => c.style.display !== 'none')
      .title,
);
check('tooltip (title)', tooltip === 'A tip', JSON.stringify(tooltip));
await page.mouse.move(...(await at(600, 600)));
check(
  'link address goes away again',
  await page
    .waitForFunction(() => document.querySelector('.bl-link-status')?.hidden, null, {
      timeout: 10000,
    })
    .then(
      () => true,
      () => false,
    ),
);

// 11) Color: a hidden color input of the host browser, the value goes to the page
await page.mouse.click(...(await at(50, 395)));
const colorPicker = await page
  .waitForSelector('input.bl-host-picker[type=color]', { state: 'attached', timeout: 10000 })
  .then(
    () => true,
    () => false,
  );
check('color picker opens', colorPicker);
if (colorPicker) {
  const startValue = await page.evaluate(
    () => document.querySelector('input.bl-host-picker').value,
  );
  await page.evaluate(() => {
    const input = document.querySelector('input.bl-host-picker');
    input.value = '#445566';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  check(
    'color reaches the page',
    startValue === '#112233' && (await result('color')) === '#445566',
    `${startValue} -> ${results.get('color')}`,
  );
}

// 12) Date: a hidden date input of the host browser
await page.mouse.click(...(await at(165, 443)));
const datePicker = await page
  .waitForSelector('input.bl-host-picker[type=date]', { state: 'attached', timeout: 10000 })
  .then(
    () => true,
    () => false,
  );
check('date picker opens', datePicker);
if (datePicker) {
  await page.evaluate(() => {
    const input = document.querySelector('input.bl-host-picker');
    input.value = '2027-03-04';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  check('date reaches the page', (await result('date')) === '2027-03-04', results.get('date'));
}

// 13) Find in the page (Ctrl+F): count matches, Esc closes
await page.mouse.click(...(await at(600, 600)));
await page.keyboard.press('Control+f');
const findOpen = await page.waitForSelector('#find-bar:not([hidden])', { timeout: 5000 }).then(
  () => true,
  () => false,
);
await page.keyboard.type('Hover');
const findCount = await page
  .waitForFunction(() => document.getElementById('find-count').textContent.includes(' of '), null, {
    timeout: 10000,
  })
  .then(
    () => page.evaluate(() => document.getElementById('find-count').textContent),
    () => null,
  );
check('find in the page', findOpen && findCount === '1 of 1', String(findCount));
await page.keyboard.press('Escape');
check('close find', await page.evaluate(() => document.getElementById('find-bar').hidden));

// 14) Zoom (Ctrl +): the page gets narrower in CSS pixels, indicator 110 %
results.delete('width');
await page.keyboard.press('Control+=');
const zoomWidth = await result('width', 10000);
const zoomLabel = await page.evaluate(() => document.getElementById('zoom').textContent);
check(
  'zoom',
  zoomLabel === '110 %' && Number(zoomWidth) < 950,
  `${zoomLabel}, innerWidth ${zoomWidth}`,
);
results.delete('width');
await page.keyboard.press('Control+0');
const resetWidth = await result('width', 10000);
check(
  'reset zoom',
  Number(resetWidth) >= 950 && (await page.evaluate(() => document.getElementById('zoom').hidden)),
  String(resetWidth),
);

// 15) Ctrl + mouse wheel: page zoom with the indicator, a click on it resets; on the "map" the
// page zooms itself and the zoom stays
const ctrlWheelAt = ([x, y]) =>
  page.evaluate(
    ([x, y]) => {
      const canvas = [...document.querySelectorAll('canvas[data-bl-view]')].find(
        (c) => c.style.display !== 'none',
      );
      canvas.dispatchEvent(
        new WheelEvent('wheel', {
          deltaY: -100,
          ctrlKey: true,
          clientX: x,
          clientY: y,
          bubbles: true,
          cancelable: true,
        }),
      );
    },
    [x, y],
  );
const zoomText = () => page.evaluate(() => document.getElementById('zoom').textContent);
await ctrlWheelAt(await at(300, 600));
await page
  .waitForFunction(() => document.getElementById('zoom').textContent === '110 %', null, {
    timeout: 10000,
  })
  .catch(() => {});
check('Ctrl + mouse wheel: page zoom indicator', (await zoomText()) === '110 %', await zoomText());
await page.click('#zoom');
check(
  'click on the zoom indicator resets',
  await page
    .waitForFunction(() => document.getElementById('zoom').hidden, null, { timeout: 10000 })
    .then(
      () => true,
      () => false,
    ),
);
await ctrlWheelAt(await at(675, 450));
await result('mapzoom', 10000);
await page.waitForTimeout(500);
check(
  'Ctrl + mouse wheel on the map: no page zoom',
  results.get('mapzoom') === '1' &&
    (await page.evaluate(() => document.getElementById('zoom').hidden)),
  await zoomText(),
);

// 16) Fullscreen: the page requests it, the demo makes the page area large; when the host browser
// ends it (like with Esc), the page notices too
await page.mouse.click(...(await at(60, 265)));
const fullscreen = await result('fs');
const hostFullscreen = await page
  .waitForFunction(() => document.fullscreenElement?.id === 'pages', null, { timeout: 10000 })
  .then(
    () => true,
    () => false,
  );
check(
  'fullscreen of the page area',
  fullscreen === 'ok' && (await result('fson')) === '1' && hostFullscreen,
  `page: ${fullscreen}, host: ${hostFullscreen}`,
);
// Crash and hang messages and the find bar stay visible in fullscreen
check(
  'fullscreen holds the engine messages and the find bar',
  await page.evaluate(() =>
    ['boot', 'find-bar'].every((id) =>
      document.fullscreenElement?.contains(document.getElementById(id)),
    ),
  ),
);
await page.evaluate(() => document.exitFullscreen().catch(() => {}));
check('ending fullscreen reaches the page', (await result('fsoff')) === '1');

await screenshot(page, 'demo-input');
await browser.close();
finish();
