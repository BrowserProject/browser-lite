// End-to-End Test fuer Kamera und Mikrofon (engine/src/media/MediaStreamWasm.cpp,
// web/capture.js): getUserMedia mit der Fake-Kamera/dem Fake-Mikrofon von
// Chromium, Abfrage wie Chrome, <video>.srcObject, canvas.drawImage(video),
// Mikrofon in Web Audio, enumerateDevices, Aufnahme-Anzeige im Tab.
//
//   cd tests/e2e && node mediastream-test.mjs [engine-ordner]
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const engineDir = path.resolve(process.argv[2] || path.join(root, 'build', 'webcore', 'bin'));
const TOKEN = 'mediastream-token-0123456789abcdef';
const RELAY_PORT = 15821;
const UI_PORT = 15822;
const TIMEOUT = Number(process.env.E2E_TIMEOUT || 180000);

setTimeout(() => {
  console.log('FAIL Zeitlimit fuer den ganzen Test');
  process.exit(1);
}, TIMEOUT + 120000).unref();

let failed = 0;
const check = (name, ok, info = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${info}`);
  if (!ok)
    failed++;
};


const PAGE = `<!doctype html><title>MediaStream-Test</title>
<style>body { margin: 0 } #start { position: absolute; left: 20px; top: 20px; width: 200px; height: 60px; } #screen { position: absolute; left: 260px; top: 20px; width: 200px; height: 60px; }</style>
<button id="start">Kamera an</button>
<button id="screen">Bildschirm teilen</button>
<script>
const log = (key, value) => console.log('RESULT ' + key + '=' + String(value).replace(/\\s/g, '_'));
log('api', typeof navigator.mediaDevices?.getUserMedia + ',' + typeof navigator.mediaDevices?.getDisplayMedia);
document.getElementById('screen').addEventListener('click', async () => {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    const video = document.createElement('video');
    video.muted = true;
    video.srcObject = stream;
    await video.play();
    await new Promise((resolve) => setTimeout(resolve, 2000));
    log('screen', video.videoWidth > 0 && video.videoHeight > 0 ? 'bild:' + stream.getVideoTracks()[0].getSettings().displaySurface : 'leer');
    stream.getTracks().forEach((track) => track.stop());
  } catch (e) {
    log('screen', e.name + ':' + e.message);
  }
});
document.getElementById('start').addEventListener('click', async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240 }, audio: true });
    log('tracks', stream.getVideoTracks().length + ':' + stream.getAudioTracks().length);
    const video = document.createElement('video');
    video.muted = true;
    video.srcObject = stream;
    video.style.cssText = 'position:absolute;left:20px;top:100px;width:320px;height:240px';
    document.body.append(video);
    await video.play();
    await new Promise((resolve) => setTimeout(resolve, 2000));
    log('videosize', video.videoWidth + 'x' + video.videoHeight);
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 48;
    const context = canvas.getContext('2d');
    context.drawImage(video, 0, 0, 64, 48);
    const pixels = context.getImageData(0, 0, 64, 48).data;
    let sum = 0;
    for (let i = 0; i < pixels.length; i += 4)
      sum += pixels[i] + pixels[i + 1] + pixels[i + 2];
    log('pixels', sum > 64 * 48 * 30 ? 'bild' : 'schwarz' + sum);
    const audioContext = new AudioContext();
    const analyser = audioContext.createAnalyser();
    audioContext.createMediaStreamSource(stream).connect(analyser);
    await audioContext.resume();
    let peak = 0;
    for (let i = 0; i < 30 && peak < 0.01; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const samples = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(samples);
      for (const value of samples)
        peak = Math.max(peak, Math.abs(value));
    }
    log('micpeak', peak > 0.01 ? 'ton' : 'still' + peak);
    const devices = await navigator.mediaDevices.enumerateDevices();
    log('devices', devices.filter((d) => d.kind !== 'audiooutput').map((d) => d.kind + ':' + d.label).sort().join(','));
    stream.getTracks().forEach((track) => track.stop());
    log('stopped', stream.getVideoTracks()[0].readyState);
  } catch (e) {
    log('error', e.name + ':' + e.message);
  }
});
</script>`;

const site = http.createServer((req, res) => res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE));
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
process.on('exit', () => {
  relay.kill();
  ui.kill();
});

// Fake-Kamera (Testbild) und Fake-Mikrofon (Piepton) von Chromium
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--auto-select-desktop-capture-source=Entire screen', '--autoplay-policy=no-user-gesture-required'] });
const context = await browser.newContext({ viewport: { width: 1000, height: 700 }, permissions: ['camera', 'microphone'] });
const page = await context.newPage();
const results = new Map();
page.on('console', (msg) => {
  const text = msg.text();
  const match = /RESULT (\w+)=(\S*)/.exec(text);
  if (match)
    results.set(match[1], match[2]);
  if (process.env.E2E_VERBOSE)
    console.log('   ', text);
});
async function result(key, ms = TIMEOUT) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (results.has(key))
      return results.get(key);
    if (results.has('error'))
      return null;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

const query = new URLSearchParams({ relay: `ws://127.0.0.1:${RELAY_PORT}/wisp/`, token: TOKEN, url: siteURL, debug: '1' });
await page.goto(`http://localhost:${UI_PORT}/?${query}`);
check('mediaDevices.getUserMedia/getDisplayMedia vorhanden', await result('api') === 'function,function', results.get('api'));
const box = await page.evaluate(() => {
  const canvas = [...document.querySelectorAll('canvas.page')].find((c) => c.style.display !== 'none');
  const rect = canvas.getBoundingClientRect();
  return { x: rect.left, y: rect.top };
});
await page.mouse.click(box.x + 120, box.y + 50);
const prompt = page.locator('#permission-prompt:not([hidden])');
const promptShown = await prompt.waitFor({ timeout: 15000 }).then(() => true, () => false);
check('Abfrage fuer Kamera und Mikrofon', promptShown && /Kamera und dein Mikrofon/.test(await prompt.textContent()), promptShown ? await prompt.textContent() : '');
if (promptShown)
  await prompt.locator('button', { hasText: 'Zulassen' }).click();
const err = () => results.get('error') || '';
check('Stream mit Video- und Tonspur', await result('tracks', 30000) === '1:1', results.get('tracks') || err());
check('Aufnahme-Anzeige im Tab', await page.locator('#tab-list .tab.active .recording:not([hidden])').waitFor({ timeout: 10000 }).then(() => true, () => false));
check('<video>.srcObject zeigt die Kamera', await result('videosize', 30000) === '320x240', results.get('videosize') || err());
check('canvas.drawImage(video) hat das Bild', await result('pixels', 30000) === 'bild', results.get('pixels') || err());
check('Mikrofon in Web Audio (MediaStreamSource)', await result('micpeak', 30000) === 'ton', results.get('micpeak') || err());
check('enumerateDevices mit Namen nach Erlaubnis', await result('devices', 30000) === 'audioinput:Mikrofon,videoinput:Kamera', results.get('devices') || err());
check('track.stop() beendet die Spur', await result('stopped', 30000) === 'ended', results.get('stopped') || err());
await page.mouse.click(box.x + 360, box.y + 50);
check('getDisplayMedia zeigt den Bildschirm', await result('screen', 30000) === 'bild:monitor', results.get('screen'));

await browser.close();
relay.kill();
ui.kill();
site.close();
console.log(failed ? `${failed} Test(s) fehlgeschlagen` : 'Alle Tests ok');
process.exit(failed ? 1 : 0);
