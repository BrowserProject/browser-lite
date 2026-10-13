// End-to-End Test fuer Kamera und Mikrofon (engine/src/media/MediaStreamWasm.cpp,
// web/capture.js): getUserMedia mit der Fake-Kamera/dem Fake-Mikrofon von
// Chromium, Abfrage wie Chrome, <video>.srcObject, canvas.drawImage(video),
// Mikrofon in Web Audio, enumerateDevices, Aufnahme-Anzeige im Tab. MediaRecorder
// (engine/src/media/MediaRecorderWasm.cpp) nimmt Canvas + Web Audio als WebM auf,
// das echte Chromium spielt die Datei ab.
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
<style>body { margin: 0 } #start { position: absolute; left: 20px; top: 20px; width: 200px; height: 60px; } #screen { position: absolute; left: 260px; top: 20px; width: 200px; height: 60px; } #rec { position: absolute; left: 500px; top: 20px; width: 200px; height: 60px; }</style>
<button id="start">Kamera an</button>
<button id="screen">Bildschirm teilen</button>
<button id="rec">Aufnehmen</button>
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
document.getElementById('rec').addEventListener('click', async () => {
  try {
    const types = ['video/webm', 'video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9', 'audio/webm;codecs=opus', 'video/mp4', 'audio/webm;codecs=vp8'];
    log('rectypes', types.map((type) => MediaRecorder.isTypeSupported(type) ? 1 : 0).join(','));
    // Bild: Canvas mit wechselnder Farbe, Ton: 440 Hz aus Web Audio
    const canvas = document.createElement('canvas');
    canvas.width = 160;
    canvas.height = 120;
    const context = canvas.getContext('2d');
    let frame = 0;
    const draw = () => {
      context.fillStyle = frame++ % 2 ? 'rgb(255,0,0)' : 'rgb(0,0,255)';
      context.fillRect(0, 0, 160, 120);
    };
    draw();
    const timer = setInterval(draw, 50);
    const audioContext = new AudioContext();
    const oscillator = audioContext.createOscillator();
    oscillator.frequency.value = 440;
    const destination = audioContext.createMediaStreamDestination();
    oscillator.connect(destination);
    oscillator.start();
    await audioContext.resume();
    const stream = new MediaStream([...canvas.captureStream(20).getVideoTracks(), ...destination.stream.getAudioTracks()]);
    const recorder = new MediaRecorder(stream);
    const chunks = [];
    const events = [];
    recorder.ondataavailable = (event) => {
      events.push('data');
      if (event.data.size)
        chunks.push(event.data);
    };
    recorder.onstart = () => events.push('start');
    const stopped = new Promise((resolve) => recorder.onstop = resolve);
    recorder.start(500);
    log('recstate', recorder.state);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    recorder.stop();
    await stopped;
    clearInterval(timer);
    oscillator.stop();
    log('recmime', recorder.mimeType);
    log('recevents', events[0] + ':' + events.filter((e) => e === 'data').length);
    const blob = new Blob(chunks, { type: recorder.mimeType });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    log('recsize', bytes.length);
    let binary = '';
    for (const byte of bytes)
      binary += String.fromCharCode(byte);
    log('recdata', btoa(binary));
  } catch (e) {
    log('recerror', e.name + ':' + e.message);
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

// MediaRecorder: Canvas + Web Audio als WebM
await page.mouse.click(box.x + 600, box.y + 50);
const recErr = () => results.get('recerror') || '';
check('MediaRecorder.isTypeSupported wie Chrome', await result('rectypes', 30000) === '1,1,1,1,0,0', results.get('rectypes') || recErr());
check('MediaRecorder nimmt auf', await result('recstate', 30000) === 'recording', results.get('recstate') || recErr());
check('MediaRecorder.mimeType wie Chrome', await result('recmime', 30000) === 'video/webm;codecs=vp8,opus', results.get('recmime') || recErr());
const recEvents = await result('recevents', 30000);
check('start und mehrere dataavailable (timeslice)', /^start:([3-9]|\d\d)$/.test(recEvents || ''), recEvents || recErr());
const recData = await result('recdata', 30000);
const webm = recData ? Buffer.from(recData, 'base64') : Buffer.alloc(0);
check('WebM-Datei (EBML-Kopf)', webm.length > 2000 && webm.readUInt32BE(0) === 0x1A45DFA3, `${webm.length} Bytes`);
// Das echte Chromium spielt die Aufnahme ab: Bildgroesse, Farbe, Ton
const playback = await page.evaluate(async (base64) => {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: 'video/webm' }));
  const video = document.createElement('video');
  video.muted = true;
  video.src = url;
  await new Promise((resolve, reject) => {
    video.onloadeddata = resolve;
    video.onerror = () => reject(new Error('video error ' + (video.error && video.error.message)));
  });
  const canvas = document.createElement('canvas');
  canvas.width = 16;
  canvas.height = 12;
  const context = canvas.getContext('2d');
  const colors = [];
  for (const time of [0, 0.5, 1, 1.5]) {
    video.currentTime = time;
    await new Promise((resolve) => video.onseeked = resolve);
    context.drawImage(video, 0, 0, 16, 12);
    colors.push([...context.getImageData(8, 6, 1, 1).data.slice(0, 3)]);
  }
  const [r, g, b] = colors[2];
  const audio = await new AudioContext().decodeAudioData(bytes.buffer.slice(0));
  const samples = audio.getChannelData(0);
  let peak = 0;
  for (const value of samples)
    peak = Math.max(peak, Math.abs(value));
  return { size: video.videoWidth + 'x' + video.videoHeight, color: [r, g, b], colors, audioSeconds: Math.round(audio.duration * 10) / 10, peak: Math.round(peak * 100) / 100 };
}, recData || '').catch((e) => ({ error: String(e) }));
check('Chromium spielt die Aufnahme ab (Bild)', playback.size === '160x120' && (playback.color[0] > 200 || playback.color[2] > 200), JSON.stringify(playback));
check('Chromium spielt die Aufnahme ab (Ton)', playback.audioSeconds >= 1.5 && playback.peak > 0.3, JSON.stringify(playback));

await browser.close();
relay.kill();
ui.kill();
site.close();
console.log(failed ? `${failed} Test(s) fehlgeschlagen` : 'Alle Tests ok');
process.exit(failed ? 1 : 0);
