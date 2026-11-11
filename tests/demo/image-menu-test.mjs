// The image and link commands of the context menu like Chrome: a right click on a linked image
// offers Save link as, Save image as, Copy image and Copy image address. Copy image puts the
// image at its full size (not as shown) as PNG on the host clipboard; Save image as and Save link
// as download the address with the page's cookies and referrer, also a text file the tab would
// show, and the files reach the host browser.
//
//   node tests/demo/image-menu-test.mjs [engine-dir]
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import {
  BROWSER,
  TIMEOUT,
  canvasOrigin,
  check,
  collect,
  finish,
  launch,
  permissions,
  screenshot,
  serve,
  startStack,
  timeLimit,
  waitFor,
  watchErrors,
} from '../lib/index.mjs';

timeLimit();

/** A PNG of width x height, left half red and right half blue. */
function png(width, height) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes) => {
    let c = 0xffffffff;
    for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) row.set(x < width / 2 ? [255, 0, 0] : [0, 0, 255], 1 + x * 3);
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const IMAGE = png(40, 30);
// Shown at half its size: Copy image takes the image, not what is on the screen
const PAGE = `<!doctype html><title>Image menu</title>
<style>body { margin: 0 } a { position: absolute; left: 20px; top: 40px }</style>
<a href="/note.txt"><img src="/photo.png" width="200" height="150"></a>
<script>
document.cookie = 'session=s3cret; path=/';
document.querySelector('img').decode().then(() => console.log('RESULT ready=1'));
</script>`;

const requests = [];
const { url: siteURL } = await serve((req, res) => {
  requests.push({ url: req.url, cookie: req.headers.cookie ?? '', referer: req.headers.referer });
  if (req.url === '/') res.writeHead(200, { 'Content-Type': 'text/html' }).end(PAGE);
  else if (req.url === '/photo.png') res.writeHead(200, { 'Content-Type': 'image/png' }).end(IMAGE);
  else if (req.url === '/note.txt')
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('a note\n');
  else res.writeHead(404).end();
});

const stack = await startStack({ app: 'demo', token: 'image-menu-token-0123456789abcdef' });
const browser = await launch();
const context = await browser.newContext({
  viewport: { width: 1000, height: 700 },
  acceptDownloads: true,
  permissions: permissions(['clipboard-read', 'clipboard-write']),
});
// The clipboard writes of the host page with their outcome: WebKit lets a page read the clipboard
// only in a click, there the test decodes the item that was written
await context.addInitScript(() => {
  const write = Clipboard.prototype.write;
  window.blWrites = [];
  Clipboard.prototype.write = function (items) {
    const entry = { state: 'pending', items };
    window.blWrites.push(entry);
    const result = write.call(this, items);
    result.then(
      () => {
        entry.state = 'ok';
      },
      (error) => {
        entry.state = error.name;
      },
    );
    return result;
  };
});
const page = await context.newPage();
watchErrors(page);
const results = collect(page);
await page.goto(stack.app({ url: siteURL }));
check('page ready', (await results.wait('ready', TIMEOUT)) === '1');
const hostDownloads = [];
page.on('download', (download) => hostDownloads.push(download));

const box = await canvasOrigin(page);
const openMenu = async () => {
  await page.mouse.click(box.x + 120, box.y + 115, { button: 'right' });
  return page
    .waitForSelector('.bl-context-menu', { timeout: 10000 })
    .then(() => true)
    .catch(() => false);
};
const item = (id) => page.locator(`.bl-context-menu button[data-bl-item=${id}]`);

// The menu of a linked image: like Chrome the link's and the image's commands
check('right click on the image: menu', await openMenu());
const rows = await page
  .locator('.bl-context-menu .bl-menu-item')
  .evaluateAll((nodes) => nodes.map((node) => `${node.dataset.blItem}:${node.textContent}`));
check(
  'link and image commands like Chrome',
  rows.slice(0, 7).join('|') ===
    [
      'open-link:Open link in new tab',
      'save-link:Save link as…',
      'copy-link:Copy link address',
      'open-image:Open image in new tab',
      'save-image:Save image as…',
      'copy-image:Copy image',
      'copy-image-address:Copy image address',
    ].join('|'),
  rows.join(' | '),
);
await screenshot(page, 'image-menu');

// Copy image: the PNG on the host clipboard has the image's own size and colors
await page.evaluate(() => navigator.clipboard.writeText('before'));
await item('copy-image').click();
const readImage = () =>
  page.evaluate(async (fromWrite) => {
    try {
      const items = fromWrite
        ? window.blWrites.at(-1)?.state === 'ok'
          ? window.blWrites.at(-1).items
          : []
        : await navigator.clipboard.read();
      const types = items[0]?.types ?? [];
      if (!types.includes('image/png')) return { types };
      const bitmap = await createImageBitmap(await items[0].getType('image/png'));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d');
      context.drawImage(bitmap, 0, 0);
      const pixel = (x, y) => [...context.getImageData(x, y, 1, 1).data.slice(0, 3)].join(',');
      return {
        types,
        width: bitmap.width,
        height: bitmap.height,
        left: pixel(5, 5),
        right: pixel(35, 25),
      };
    } catch (error) {
      return { error: error.message };
    }
  }, BROWSER === 'webkit');
let copied = null;
await waitFor(async () => {
  copied = await readImage();
  return !!copied.width;
}, 15000);
const written = await page.evaluate(() => window.blWrites.at(-1)?.state);
check('Copy image: the host browser accepted the write in the click', written === 'ok', written);
check(
  'Copy image: a PNG on the clipboard',
  copied?.types?.includes('image/png'),
  JSON.stringify(copied),
);
check(
  'Copy image: at the size of the image, not as shown',
  copied?.width === 40 && copied?.height === 30,
  `${copied?.width}x${copied?.height}`,
);
check(
  'Copy image: its pixels',
  copied?.left === '255,0,0' && copied?.right === '0,0,255',
  `${copied?.left} ${copied?.right}`,
);

// Save image as: a request of its own with the page's cookie and referrer, the file reaches the host
const download = async (id, path) => {
  const before = requests.filter((request) => request.url === path).length;
  const saved = hostDownloads.length;
  if (!(await openMenu())) return null;
  await item(id).click();
  await waitFor(() => hostDownloads.length > saved, 20000);
  const file = hostDownloads[saved];
  const request = requests.filter((request) => request.url === path)[before];
  return {
    request,
    name: file?.suggestedFilename(),
    bytes: file ? readFileSync(await file.path()) : null,
  };
};
const image = await download('save-image', '/photo.png');
check('Save image as: the file reaches the host', image?.name === 'photo.png', image?.name);
check(
  'Save image as: the bytes of the image',
  !!image?.bytes && Buffer.compare(image.bytes, IMAGE) === 0,
  `${image?.bytes?.length} bytes`,
);
check(
  "Save image as: with the page's cookie and referrer",
  image?.request?.cookie.includes('session=s3cret') && image?.request?.referer === siteURL,
  JSON.stringify(image?.request),
);

// Save link as: a text file the tab would show becomes a download, the page stays
const link = await download('save-link', '/note.txt');
check(
  'Save link as: a text file is downloaded',
  link?.name === 'note.txt' && link?.bytes?.toString() === 'a note\n',
  `${link?.name} ${JSON.stringify(link?.bytes?.toString())}`,
);
const address = await page.evaluate(() => document.getElementById('address').value);
check('Save link as: the tab stays on the page', !address.includes('note.txt'), address);

console.log(`(${BROWSER})`);
await browser.close();
finish();
