// End-to-End Test fuer <video>/<audio>: das versteckte <video> der Oberflaeche
// spielt ab, die Daten kommen ueber den Service Worker von der Engine
// (Range-Requests ueber das Relay), die Bilder malt die Engine in die Seite.
//
// Testdateien werden hier erzeugt: ein WAV (30 s, mehrere Stuecke a 2 MB)
// und ein WebM-Clip, aufgenommen mit MediaRecorder im Test-Chromium.
//
//   cd tests/e2e && node media-test.mjs [engine-ordner]
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const engineDir = path.resolve(process.argv[2] || path.join(root, 'build', 'webcore', 'bin'));
const TOKEN = 'media-token-0123456789abcdef';
const RELAY_PORT = 15601;
const UI_PORT = 15602;
const TIMEOUT = Number(process.env.E2E_TIMEOUT || 180000);

setTimeout(() => {
  console.log('FAIL Zeitlimit fuer den ganzen Test');
  process.exit(1);
}, TIMEOUT + 180000).unref();

let failed = 0;
const check = (name, ok, info = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${info}`);
  if (!ok)
    failed++;
};

// --------------------------------------------------------- Testdateien

function wav(seconds, rate = 44100) {
  const frames = seconds * rate;
  const buffer = Buffer.alloc(44 + frames * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + frames * 2, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++)
    buffer.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * i / rate) * 8000), 44 + i * 2);
  return buffer;
}
const TONE = wav(30);

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });

// WebM: 3 s, Canvas immer rot (Farbe pruefen wir spaeter in der Engine)
async function recordClip() {
  const recorder = await browser.newPage();
  await recorder.goto('about:blank');
  const bytes = await recorder.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 240;
    const ctx = canvas.getContext('2d');
    const stream = canvas.captureStream(25);
    const media = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
    const chunks = [];
    media.ondataavailable = (e) => chunks.push(e.data);
    const timer = setInterval(() => {
      ctx.fillStyle = '#e00000';
      ctx.fillRect(0, 0, 320, 240);
    }, 40);
    media.start(500);
    await new Promise((r) => setTimeout(r, 3000));
    await new Promise((r) => { media.onstop = r; media.stop(); });
    clearInterval(timer);
    const blob = new Blob(chunks, { type: 'video/webm' });
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  await recorder.close();
  return Buffer.from(bytes);
}
const CLIP = await recordClip();
console.log(`Testdateien: WAV ${(TONE.length / 1e6).toFixed(1)} MB, WebM ${(CLIP.length / 1e3).toFixed(0)} kB`);

const PAGE = `<!doctype html><title>Media-Test</title><body style="margin:0;background:#fff">
<video id="video" src="/clip.webm" muted playsinline style="position:absolute;left:20px;top:20px;width:320px;height:240px"></video>
<audio id="audio" src="/tone.wav" muted preload="auto"></audio>
<script>
const result = (key, value) => console.log('RESULT ' + key + '=' + value);
const video = document.getElementById('video');
const audio = document.getElementById('audio');
video.addEventListener('loadedmetadata', () => result('videometa', video.videoWidth + 'x' + video.videoHeight));
video.addEventListener('playing', () => result('videoplaying', '1'));
video.addEventListener('error', () => result('videoerror', video.error && video.error.code));
video.play().then(() => result('videoplay', 'ok'), (e) => result('videoplay', e.name));

audio.addEventListener('loadedmetadata', () => result('audioduration', audio.duration.toFixed(1)));
audio.addEventListener('error', () => result('audioerror', audio.error && audio.error.code));
let seekedOnce = false;
audio.addEventListener('seeked', () => {
  if (!seekedOnce) {
    seekedOnce = true;
    result('audioseeked', audio.currentTime.toFixed(1));
    setTimeout(() => result('audioafter', audio.currentTime.toFixed(1)), 1500);
  }
});
audio.addEventListener('playing', () => {
  setTimeout(() => {
    result('audiotime', audio.currentTime.toFixed(1));
    audio.currentTime = 25;
  }, 1500);
}, { once: true });
audio.play().then(() => result('audioplay', 'ok'), (e) => result('audioplay', e.name));
</script>`;

// MSE: Clip in zwei ungeraden Teilen anhaengen (prueft auch den Parser mit halben Elementen)
const MSE_PAGE = `<!doctype html><title>MSE-Test</title><body style="margin:0;background:#fff">
<video id="video" muted playsinline style="position:absolute;left:20px;top:20px;width:320px;height:240px"></video>
<script>
const result = (key, value) => console.log('RESULT ' + key + '=' + value);
const type = 'video/webm; codecs="vp8"';
result('msesupported', MediaSource.isTypeSupported(type));
const video = document.getElementById('video');
const source = new MediaSource();
video.src = URL.createObjectURL(source);
source.addEventListener('sourceopen', async () => {
  const data = new Uint8Array(await (await fetch('/clip.webm')).arrayBuffer());
  const buffer = source.addSourceBuffer(type);
  const append = (part) => new Promise((resolve) => { buffer.addEventListener('updateend', resolve, { once: true }); buffer.appendBuffer(part); });
  const middle = Math.floor(data.length / 2) + 7;
  await append(data.subarray(0, middle));
  await append(data.subarray(middle));
  result('msebuffered', buffer.buffered.length ? buffer.buffered.end(0).toFixed(1) : 'leer');
  source.endOfStream();
  result('mseduration', video.duration.toFixed(1));
  video.addEventListener('playing', () => result('mseplaying', '1'));
  let removed = false;
  video.addEventListener('timeupdate', () => {
    if (video.currentTime <= 1.2)
      return;
    result('msetime', video.currentTime.toFixed(1));
    // Danach das Ende wegwerfen, der Host muss es auch tun
    if (removed)
      return;
    removed = true;
    buffer.addEventListener('updateend', () => result('mseremoved', buffer.buffered.length ? buffer.buffered.end(0).toFixed(1) : 'leer'), { once: true });
    buffer.remove(2.5, Infinity);
  });
  video.play().then(() => result('mseplay', 'ok'), (e) => result('mseplay', e.name));
});
</script>`;

const ranges = [];
const site = http.createServer((req, res) => {
  const files = { '/clip.webm': [CLIP, 'video/webm'], '/tone.wav': [TONE, 'audio/wav'] };
  if (req.url === '/' || req.url === '/mse.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(req.url === '/' ? PAGE : MSE_PAGE);
    return;
  }
  const file = files[req.url];
  if (!file) {
    res.writeHead(404).end();
    return;
  }
  const [data, type] = file;
  const match = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  if (!match) {
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length, 'Accept-Ranges': 'bytes' }).end(data);
    return;
  }
  const start = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), data.length - 1) : data.length - 1;
  ranges.push(`${req.url}:${start}-${end}`);
  res.writeHead(206, { 'Content-Type': type, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${data.length}`, 'Accept-Ranges': 'bytes' });
  res.end(data.subarray(start, end + 1));
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const siteURL = `http://127.0.0.1:${site.address().port}/`;

function start(script, args, env) {
  const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((resolve) => child.stdout.on('data', (d) => {
    if (/laeuft|browser-lite auf/.test(d.toString()))
      resolve(child);
  }));
}
const relay = await start(path.join(root, 'relay', 'server.mjs'), [],
  { RELAY_TOKEN: TOKEN, PORT: String(RELAY_PORT), HOST: '127.0.0.1', RELAY_ALLOW_LOCAL: '1' });
const ui = await start(path.join(root, 'web', 'serve.mjs'), [String(UI_PORT), engineDir], {});

const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
const results = new Map();
page.on('console', (msg) => {
  const match = /RESULT (\w+)=(\S*)/.exec(msg.text());
  if (match)
    results.set(match[1], match[2]);
  else if (process.env.E2E_VERBOSE)
    console.log('   ', msg.text());
});
page.on('pageerror', (error) => console.log('   Seitenfehler:', error.message));
async function result(key, timeout = TIMEOUT) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (results.has(key))
      return results.get(key);
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

const query = new URLSearchParams({ relay: `ws://127.0.0.1:${RELAY_PORT}/wisp/`, token: TOKEN, url: siteURL });
await page.goto(`http://localhost:${UI_PORT}/?${query}`);

check('Video: Metadaten', (await result('videometa')) === '320x240', results.get('videoerror') ? `Fehler ${results.get('videoerror')}` : results.get('videometa'));
check('Video: play() (stumm, ohne Klick)', (await result('videoplay')) === 'ok', results.get('videoplay'));
check('Video: spielt', (await result('videoplaying')) === '1');

// Ein rotes Bild muss an der Stelle des Videos in der Seite sein
let pixel = null;
const end = Date.now() + 20000;
while (Date.now() < end) {
  pixel = await page.evaluate(() => {
    const canvas = [...document.querySelectorAll('canvas.page')].find((c) => c.style.display !== 'none');
    const ratio = canvas.width / canvas.getBoundingClientRect().width;
    const [r, g, b] = canvas.getContext('2d').getImageData(Math.round(180 * ratio), Math.round(140 * ratio), 1, 1).data;
    return { r, g, b };
  });
  if (pixel.r > 180 && pixel.g < 60 && pixel.b < 60)
    break;
  await page.waitForTimeout(250);
}
check('Video: Bild in der Seite gemalt', pixel && pixel.r > 180 && pixel.g < 60 && pixel.b < 60, JSON.stringify(pixel));

check('Audio: Dauer bekannt', (await result('audioduration')) === '30.0', results.get('audioerror') ? `Fehler ${results.get('audioerror')}` : results.get('audioduration'));
check('Audio: play()', (await result('audioplay')) === 'ok', results.get('audioplay'));
const audioTime = Number(await result('audiotime'));
check('Audio: Zeit laeuft', audioTime > 0.8 && audioTime < 3, String(audioTime));
const seeked = Number(await result('audioseeked'));
check('Audio: Springen an 25 s', Math.abs(seeked - 25) < 0.5, String(seeked));
const after = Number(await result('audioafter'));
check('Audio: spielt nach dem Springen weiter', after > seeked + 0.5, String(after));
const toneRanges = ranges.filter((r) => r.startsWith('/tone.wav'));
check('Daten in Stuecken (Range ueber das Relay)', toneRanges.length >= 2, toneRanges.join(' '));

await page.screenshot({ path: path.join(root, 'build', 'e2e-media.png') }).catch(() => {});

// ------------------------------------------------------------------ MSE
await page.fill('#address', siteURL + 'mse.html');
await page.press('#address', 'Enter');
check('MSE: isTypeSupported(WebM/VP8)', (await result('msesupported')) === 'true', results.get('msesupported'));
const mseBuffered = Number(await result('msebuffered'));
check('MSE: buffered nach zwei Teilen', mseBuffered > 2.5 && mseBuffered < 3.6, String(mseBuffered));
check('MSE: play()', (await result('mseplay')) === 'ok', results.get('mseplay'));
check('MSE: spielt', (await result('mseplaying')) === '1');
const mseTime = Number(await result('msetime'));
check('MSE: Zeit laeuft', mseTime > 1, String(mseTime));
let msePixel = null;
const mseEnd = Date.now() + 20000;
while (Date.now() < mseEnd) {
  msePixel = await page.evaluate(() => {
    const canvas = [...document.querySelectorAll('canvas.page')].find((c) => c.style.display !== 'none');
    const ratio = canvas.width / canvas.getBoundingClientRect().width;
    const [r, g, b] = canvas.getContext('2d').getImageData(Math.round(180 * ratio), Math.round(140 * ratio), 1, 1).data;
    return { r, g, b };
  });
  if (msePixel.r > 180 && msePixel.g < 60 && msePixel.b < 60)
    break;
  await page.waitForTimeout(250);
}
check('MSE: Bild in der Seite gemalt', msePixel && msePixel.r > 180 && msePixel.g < 60 && msePixel.b < 60, JSON.stringify(msePixel));
await page.screenshot({ path: path.join(root, 'build', 'e2e-mse.png') }).catch(() => {});
const mseRemoved = await result('mseremoved');
check('MSE: remove() in der Engine', Number(mseRemoved) > 2 && Number(mseRemoved) <= 2.5, mseRemoved);
let hostBuffered = null;
const removeEnd = Date.now() + 10000;
while (Date.now() < removeEnd) {
  const players = await page.evaluate(() => window.__blMediaState());
  hostBuffered = players.length ? players[players.length - 1].buffered : null;
  if (hostBuffered && hostBuffered.length && hostBuffered[hostBuffered.length - 1][1] < 2.6)
    break;
  await page.waitForTimeout(250);
}
check('MSE: remove() auch im Host', hostBuffered && hostBuffered.length && hostBuffered[hostBuffered.length - 1][1] < 2.6, JSON.stringify(hostBuffered));
await browser.close();
relay.kill();
ui.kill();
site.close();
console.log(failed ? `${failed} Test(s) fehlgeschlagen` : 'Alle Tests ok');
process.exit(failed ? 1 : 0);
