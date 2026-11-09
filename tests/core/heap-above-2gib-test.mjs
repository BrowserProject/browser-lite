// Engine memory above 2 GiB (MAXIMUM_MEMORY is 4 GiB): a wasm32 pointer at or above 2 GiB reaches
// the JS glue as a negative number unless the glue makes it unsigned (tests/contract/pointers-test.mjs).
// The page runs the same checks with little memory and again after it filled the engine memory
// past 2 GiB with arrays of the float64 1.5; both rounds must give the same answers: uploads arrive
// byte for byte (blJsSocketSend), a response lands in the HTTP cache unchanged (blJsHttpCacheStore),
// hot functions install without a CompileError and compute the same (wasmJITInstall),
// decodeAudioData gives the same samples (patch 0099).
//
//   node tests/core/heap-above-2gib-test.mjs [engine-dir]
import crypto from 'node:crypto';
import {
  check,
  collect,
  finish,
  launch,
  openHost,
  serve,
  startStack,
  timeLimit,
  wav,
} from '../lib/index.mjs';

timeLimit();

const GiB = 2 ** 30;
const TARGET = 2.2 * GiB;
const UPLOAD = 2 << 20;
const uploadByte = (i) => (i * 13 + 5) & 255;
const cachedBody = Buffer.alloc(1 << 20);
for (let i = 0; i < cachedBody.length; i++) cachedBody[i] = (i * 7 + (i >> 8)) & 255;
const sha1 = (bytes) => crypto.createHash('sha1').update(bytes).digest('hex');

const PAGE = `<!doctype html><title>Heap</title><body>Heap<script>
const keep = [];
// count arrays of bytes each that stay in the engine memory
window.grow = (step, count, bytes) => {
  for (let i = 0; i < count; i++) {
    const array = new Float64Array(bytes / 8);
    array.fill(1.5);
    keep.push(array);
  }
  console.log('RESULT grown' + step + '=1');
};
const hash = (bytes) => {
  let h = 0;
  for (let i = 0; i < bytes.length; i++) h = (Math.imul(h, 31) + bytes[i]) | 0;
  return h;
};
window.run = async (round) => {
  const parts = [];
  try {
    let length = 0, wrong = 0;
    for (let k = 0; k < 4; k++) {
      const body = new Uint8Array(${UPLOAD});
      for (let i = 0; i < body.length; i++) body[i] = (i * 13 + 5) & 255;
      const answer = (await (await fetch('/echo', { method: 'POST', body })).text()).split(' ');
      length += Number(answer[0]);
      wrong += Number(answer[1]);
    }
    parts.push('upload:' + length + '/' + wrong);
  } catch (e) { parts.push('upload:' + e.name); }
  try {
    parts.push('cached:' + hash(new Uint8Array(await (await fetch('/cached?round=' + round)).arrayBuffer())));
  } catch (e) { parts.push('cached:' + e.name); }
  let sum = 0;
  for (let k = 0; k < 40; k++) {
    const f = new Function('a', 'let t = 0; for (let i = 0; i < a; i++) t = (t + i * ' + (k + 3) + ') | 0; return t;');
    for (let j = 0; j < 3000; j++) sum += f(50);
  }
  parts.push('jit:' + sum);
  try {
    const buffer = await new OfflineAudioContext(1, 1, 22050).decodeAudioData(await (await fetch('/tone.wav')).arrayBuffer());
    const data = buffer.getChannelData(0);
    let level = 0;
    for (let i = 0; i < data.length; i++) level += Math.abs(data[i]);
    parts.push('audio:' + buffer.length + '/' + level.toFixed(2));
  } catch (e) { parts.push('audio:' + e.name); }
  console.log('RESULT round' + round + '=' + parts.join(','));
};
console.log('RESULT loaded=1');
</script>`;

let cachedRequests = 0;
const tone = wav(1);
const { url: siteURL } = await serve((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    if (req.url === '/echo') {
      const body = Buffer.concat(chunks);
      let wrong = 0;
      for (let i = 0; i < body.length; i++) if (body[i] !== uploadByte(i)) wrong++;
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end(`${body.length} ${wrong}`);
    } else if (req.url.startsWith('/cached')) {
      cachedRequests++;
      res
        .writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Cache-Control': 'max-age=3600',
        })
        .end(cachedBody);
    } else if (req.url === '/tone.wav') {
      res.writeHead(200, { 'Content-Type': 'audio/wav' }).end(tone);
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE);
    }
  });
});

const stack = await startStack({ token: 'heap-token-0123456789abcdef' });
const browser = await launch();
const page = await browser.newPage();
const results = collect(page);
check('host page starts', await openHost(page, stack.app({ url: siteURL, persistent: '1' })));
check('page loaded', (await results.wait('loaded')) === '1');

const heap = () => page.evaluate(() => window.blTest.memory());
// The body the HTTP cache stored in the host's Cache API for the address of a round
const storedBody = (round) =>
  page.evaluate(async (suffix) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      for (const name of await caches.keys()) {
        if (!/-http-v\d+$/.test(name)) continue;
        const cache = await caches.open(name);
        for (const request of await cache.keys()) {
          if (!new URL(request.url).searchParams.get('u')?.endsWith(suffix)) continue;
          const response = await cache.match(request);
          return [...new Uint8Array(await response.arrayBuffer())];
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return null;
  }, `/cached?round=${round}`);

async function round(n) {
  await page.evaluate((r) => window.blTest.eval(`run(${r})`), n);
  const answer = await results.wait(`round${n}`, 120000);
  const stored = await storedBody(n);
  return { answer, stored: stored ? sha1(Buffer.from(stored)) : null };
}

const expected = sha1(cachedBody);
const low = await round(1);
check(
  'with little memory: all checks answer',
  !!low.answer && !/Error/.test(low.answer),
  low.answer,
);
check(
  'with little memory: the uploads arrive unchanged',
  low.answer?.includes(`upload:${4 * UPLOAD}/0,`),
  low.answer,
);
check(
  'with little memory: the HTTP cache stored the response unchanged',
  low.stored === expected,
  String(low.stored),
);

// Arrays of 128 MB take the memory past 2 GiB, then 256 MB of 16 KB arrays fill the gaps below, so
// what the engine allocates next lands above 2 GiB
let steps = 0;
const grow = async (count, bytes) => {
  steps++;
  await page.evaluate((call) => window.blTest.eval(call), `grow(${steps}, ${count}, ${bytes})`);
  return (await results.wait(`grown${steps}`, 60000)) === '1';
};
while ((await heap()) < TARGET && steps < 40) if (!(await grow(1, 128 << 20))) break;
for (let i = 0; i < 16; i++) await grow(1024, 16 << 10);
const size = await heap();
check(
  'the engine memory grew past 2 GiB',
  size >= TARGET,
  `${(size / GiB).toFixed(2)} GiB after ${steps} fills`,
);

const high = await round(2);
check(
  'above 2 GiB: the same answers as with little memory',
  high.answer === low.answer,
  `${high.answer} (before ${low.answer})`,
);
check(
  'above 2 GiB: the uploads arrive unchanged',
  high.answer?.includes(`upload:${4 * UPLOAD}/0,`),
  high.answer,
);
check(
  'above 2 GiB: the HTTP cache stored the response unchanged',
  high.stored === expected,
  String(high.stored),
);
const jitErrors = results.logs.filter((line) => /\[jit\].*Error/.test(line));
check(
  'no compiled function failed to install',
  jitErrors.length === 0,
  jitErrors.slice(0, 3).join(' | '),
);
check('each round fetched its response once', cachedRequests === 2, String(cachedRequests));
check(
  'engine did not crash',
  !(await page.evaluate(() => window.blHost.events.some((e) => e.startsWith('crash')))),
);

await browser.close();
finish();
