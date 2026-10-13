// End-to-End Test fuer Web Audio: die Seite in der Engine macht Ton, die
// Oberflaeche spielt ihn ueber ein AudioWorklet im echten Chromium ab.
//
// Geprueft wird: Oszillator (inverse FFT fuer die Wellentabellen),
// AnalyserNode (FFT), ConvolverNode (FFT-Faltung), decodeAudioData (Dekoder
// des Host-Browsers, mit Umrechnen der Rate), HRTF-Panner (Daten in
// engine.data) und dass nach einem Klick wirklich Ton beim Host ankommt.
//
//   cd tests/e2e && node audio-test.mjs [engine-ordner]
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const engineDir = path.resolve(process.argv[2] || path.join(root, 'build', 'webcore', 'bin'));
const TOKEN = 'audio-token-0123456789abcdef';
const RELAY_PORT = 15501;
const UI_PORT = 15502;
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

const PAGE = `<!doctype html><title>Audio-Test</title><body style="margin:0;height:100vh;background:#eef">Audio-Test<script>
const result = (key, value) => console.log('RESULT ' + key + '=' + value);

// WAV (16 Bit, mono) mit einem Sinus
function wav(rate, seconds, frequency) {
  const frames = rate * seconds;
  const buffer = new ArrayBuffer(44 + frames * 2);
  const view = new DataView(buffer);
  const text = (offset, s) => { for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i)); };
  text(0, 'RIFF'); view.setUint32(4, 36 + frames * 2, true); text(8, 'WAVE'); text(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true);
  view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, frames * 2, true);
  for (let i = 0; i < frames; i++)
    view.setInt16(44 + i * 2, Math.round(Math.sin(2 * Math.PI * frequency * i / rate) * 16000), true);
  return buffer;
}

async function offlineTests() {
  // Oszillator muss ein sauberer Sinus sein
  const plain = new OfflineAudioContext(1, 4800, 48000);
  const osc = plain.createOscillator();
  osc.frequency.value = 1000;
  osc.connect(plain.destination);
  osc.start();
  const reference = (await plain.startRendering()).getChannelData(0);
  let sineError = 0;
  for (let i = 0; i < reference.length; i++)
    sineError = Math.max(sineError, Math.abs(reference[i] - Math.sin(2 * Math.PI * 1000 * i / 48000)));
  result('sine', sineError.toFixed(4));

  // Faltung mit einem um 200 Samples verschobenen Impuls = verschobenes Signal
  const offline = new OfflineAudioContext(1, 4800, 48000);
  const osc2 = offline.createOscillator();
  osc2.frequency.value = 1000;
  const convolver = offline.createConvolver();
  convolver.normalize = false;
  const impulse = offline.createBuffer(1, 1024, 48000);
  impulse.getChannelData(0)[200] = 1;
  convolver.buffer = impulse;
  osc2.connect(convolver);
  convolver.connect(offline.destination);
  osc2.start();
  const convolved = (await offline.startRendering()).getChannelData(0);
  let convolveError = 0;
  for (let i = 200; i < convolved.length; i++)
    convolveError = Math.max(convolveError, Math.abs(convolved[i] - reference[i - 200]));
  result('convolver', convolveError.toFixed(4));
}

async function hrtfTest() {
  const offline = new OfflineAudioContext(2, 9600, 48000);
  const osc = offline.createOscillator();
  const panner = new PannerNode(offline, { panningModel: 'HRTF', positionX: 1, positionZ: -1 });
  osc.connect(panner);
  panner.connect(offline.destination);
  osc.start();
  const buffer = await offline.startRendering();
  let left = 0, right = 0;
  for (let i = 4800; i < 9600; i++) {
    left = Math.max(left, Math.abs(buffer.getChannelData(0)[i]));
    right = Math.max(right, Math.abs(buffer.getChannelData(1)[i]));
  }
  // Quelle rechts: rechts lauter als links
  result('hrtf', left.toFixed(3) + ',' + right.toFixed(3));
}

(async () => {
  try {
    await offlineTests();
  } catch (e) {
    result('sine', 'fehler:' + e);
  }

  const context = new AudioContext();
  result('rate', context.sampleRate);
  // HRTF-Daten laden lassen (passiert im Hintergrund)
  new PannerNode(context, { panningModel: 'HRTF' });

  try {
    const decoded = await context.decodeAudioData(wav(22050, 1, 440));
    let peak = 0;
    for (const value of decoded.getChannelData(0))
      peak = Math.max(peak, Math.abs(value));
    result('decode', decoded.sampleRate + ',' + decoded.length + ',' + peak.toFixed(2));
  } catch (e) {
    result('decode', 'fehler:' + e);
  }

  // 440 Hz ueber Analyser zur Ausgabe (laeuft weiter, damit der Host Ton hat)
  const osc = context.createOscillator();
  osc.frequency.value = 440;
  const gain = context.createGain();
  gain.gain.value = 0.5;
  const analyser = context.createAnalyser();
  analyser.fftSize = 2048;
  osc.connect(gain);
  gain.connect(analyser);
  analyser.connect(context.destination);
  osc.start();
  const start = context.currentTime;
  setTimeout(async () => {
    const bins = new Float32Array(analyser.frequencyBinCount);
    analyser.getFloatFrequencyData(bins);
    let best = 0;
    for (let i = 1; i < bins.length; i++)
      if (bins[i] > bins[best]) best = i;
    result('analyser', Math.round(best * context.sampleRate / analyser.fftSize));
    result('time', (context.currentTime - start).toFixed(2));
    try {
      await hrtfTest();
    } catch (e) {
      result('hrtf', 'fehler:' + e);
    }
  }, 1500);
})();
</script>`;

const site = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE);
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

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage();
const results = new Map();
page.on('console', (msg) => {
  const match = /RESULT (\w+)=(\S*)/.exec(msg.text());
  if (match)
    results.set(match[1], match[2]);
  else if (process.env.E2E_VERBOSE)
    console.log('   ', msg.text());
});
page.on('pageerror', (error) => console.log('   Seitenfehler:', error.message));
async function result(key) {
  const end = Date.now() + TIMEOUT;
  while (Date.now() < end) {
    if (results.has(key))
      return results.get(key);
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

const query = new URLSearchParams({ relay: `ws://127.0.0.1:${RELAY_PORT}/wisp/`, token: TOKEN, url: siteURL });
if (process.env.E2E_DEBUG)
  query.set('debug', '1');
await page.goto(`http://localhost:${UI_PORT}/?${query}`);

const sine = await result('sine');
check('Oszillator ist ein sauberer Sinus', Number(sine) < 0.01, `(Abweichung ${sine})`);
const convolver = await result('convolver');
check('ConvolverNode (FFT-Faltung) verschiebt genau', Number(convolver) < 0.001, `(Abweichung ${convolver})`);
check('AudioContext mit 48 kHz', (await result('rate')) === '48000');
const decode = (await result('decode')) || '';
const [decodedRate, decodedLength, decodedPeak] = decode.split(',').map(Number);
check('decodeAudioData (WAV 22.05 kHz -> 48 kHz)', decodedRate === 48000 && Math.abs(decodedLength - 48000) < 100 && Math.abs(decodedPeak - 0.49) < 0.03, decode);

// Klick als Benutzer-Aktion, damit der Host-AudioContext starten darf
const box = await page.evaluate(() => {
  const canvas = [...document.querySelectorAll('canvas.page')].find((c) => c.style.display !== 'none');
  const rect = canvas.getBoundingClientRect();
  return [rect.left + 50, rect.top + 50];
});
await page.mouse.click(...box);

const analyser = Number(await result('analyser'));
check('AnalyserNode findet 440 Hz', Math.abs(analyser - 440) < 30, `(${analyser} Hz)`);
const time = Number(await result('time'));
check('currentTime laeuft', time > 1 && time < 3, `(${time} s)`);

let state = null;
const end = Date.now() + 20000;
while (Date.now() < end) {
  state = await page.evaluate(() => window.__blAudioState());
  if (state.state === 'running' && state.peak > 0.3)
    break;
  await page.waitForTimeout(250);
}
check('Ton kommt beim Host an (AudioWorklet)', state?.state === 'running' && state.peak > 0.3 && state.peak < 0.6, JSON.stringify(state));

// Lautsprecher im Tab wie Chrome: erscheint bei Ton, Klick schaltet den Tab stumm
const audioButton = page.locator('#tab-list .tab.active .audio:not([hidden])');
check('Lautsprecher im Tab', await audioButton.waitFor({ timeout: 10000 }).then(() => true, () => false));
const peakUntil = async (done) => {
  let peak = null;
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(250);
    peak = (await page.evaluate(() => window.__blAudioState())).peak;
    if (done(peak))
      break;
  }
  return peak;
};
await audioButton.click();
const mutedPeak = await peakUntil((peak) => peak <= 0.01);
check('Tab stummgeschaltet: kein Ton mehr', mutedPeak <= 0.01, String(mutedPeak));
await audioButton.click();
const unmutedPeak = await peakUntil((peak) => peak > 0.3);
check('Ton wieder an', unmutedPeak > 0.3, String(unmutedPeak));

const hrtf = (await result('hrtf')) || '';
const [left, right] = hrtf.split(',').map(Number);
check('HRTF-Panner (Quelle rechts)', right > 0.05 && right > left, hrtf);

await browser.close();
relay.kill();
ui.kill();
site.close();
console.log(failed ? `${failed} Test(s) fehlgeschlagen` : 'Alle Tests ok');
process.exit(failed ? 1 : 0);
