// End-to-End Test fuer WebRTC (engine/src/WebRTCPolyfill.cpp, web/webrtc.js):
// zwei RTCPeerConnections in der Seite (Angebot/Antwort, ICE, DataChannel mit
// Text, Binaer und Blob, Zustaende, getStats, close) und eine Verbindung
// zwischen browser-lite und einer normalen Chromium-Seite.
//
//   cd tests/e2e && node webrtc-test.mjs [engine-ordner]
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const engineDir = path.resolve(process.argv[2] || path.join(root, 'build', 'webcore', 'bin'));
const TOKEN = 'webrtc-token-0123456789abcdef';
const RELAY_PORT = 15831;
const UI_PORT = 15832;
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

const PAGE = `<!doctype html><title>WebRTC-Test</title>
<script>
const log = (key, value) => console.log('RESULT ' + key + '=' + String(value).replace(/\\s/g, '_'));
const until = (condition, ms = 20000) => new Promise((resolve, reject) => {
  const end = Date.now() + ms;
  const check = () => condition() ? resolve() : Date.now() > end ? reject(new Error('Zeitlimit')) : setTimeout(check, 20);
  check();
});
log('api', [typeof RTCPeerConnection, typeof RTCSessionDescription, typeof RTCIceCandidate, typeof RTCDataChannel].join(','));
const parsed = new RTCIceCandidate({ candidate: 'candidate:1 1 udp 2122260223 192.0.2.1 54321 typ host generation 0', sdpMid: '0' });
log('candidate', [parsed.address, parsed.port, parsed.protocol, parsed.type, parsed.component].join(','));
(async () => {
  try {
    const a = new RTCPeerConnection(), b = new RTCPeerConnection();
    a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate);
    b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate);
    let negotiation = 0;
    a.onnegotiationneeded = () => negotiation++;
    const channel = a.createDataChannel('chat', { ordered: true });
    log('channel', channel.label + ',' + channel.readyState + ',' + (channel instanceof RTCDataChannel) + ',' + (channel instanceof EventTarget));
    const gotChannel = new Promise((resolve) => b.ondatachannel = (e) => resolve(e.channel));
    await a.setLocalDescription(await a.createOffer());
    log('offer', a.signalingState + ',' + a.localDescription.type + ',' + /m=application/.test(a.localDescription.sdp));
    await b.setRemoteDescription(a.localDescription);
    await b.setLocalDescription(await b.createAnswer());
    await a.setRemoteDescription(b.localDescription);
    log('answer', a.signalingState + ',' + b.signalingState + ',' + a.remoteDescription.type);
    const remote = await gotChannel;
    await until(() => channel.readyState === 'open');
    log('open', channel.readyState + ',' + remote.label + ',' + (channel.id !== null) + ',negotiation' + negotiation);
    const messages = [];
    remote.onmessage = (e) => messages.push(typeof e.data === 'string' ? e.data : 'bin' + new Uint8Array(e.data).join('.'));
    channel.send('hallo');
    channel.send(new Uint8Array([1, 2, 3]));
    channel.send(new Blob(['blob']));
    channel.send('ende');
    await until(() => messages.length === 4);
    log('messages', messages.join('|'));
    const back = [];
    channel.binaryType = 'blob';
    channel.onmessage = async (e) => back.push(typeof e.data === 'string' ? e.data : (e.data instanceof Blob ? 'blob:' + await e.data.text() : 'anders'));
    remote.send('zurueck');
    remote.send(new TextEncoder().encode('bytes'));
    await until(() => back.length === 2);
    log('back', back.join('|'));
    await until(() => a.connectionState === 'connected' && b.connectionState === 'connected').catch((e) => {
      log('states', [a.connectionState, a.iceConnectionState, a.iceGatheringState, b.connectionState].join(','));
      throw e;
    });
    log('connected', a.connectionState + ',' + a.iceConnectionState + ',' + a.iceGatheringState);
    const stats = await a.getStats();
    log('stats', (stats instanceof Map) + ',' + [...stats.values()].some((s) => s.type === 'data-channel') + ',' + [...stats.values()].some((s) => s.type === 'candidate-pair'));
    const closed = new Promise((resolve) => remote.onclose = resolve);
    channel.close();
    await closed;
    log('channelclosed', channel.readyState + ',' + remote.readyState);
    a.close();
    b.close();
    log('closed', a.signalingState + ',' + a.connectionState);
  } catch (e) {
    log('error', e.name + ':' + e.message);
  }
})();
// Gegenstelle ausserhalb: Angebot ohne Trickle-ICE (alle Kandidaten im SDP)
window.crossConnect = async () => {
  const pc = window.crossPc = new RTCPeerConnection();
  const channel = window.crossChannel = pc.createDataChannel('kreuz');
  channel.onmessage = (e) => log('crossmessage', e.data);
  channel.onopen = () => channel.send('hallo von browser-lite');
  await pc.setLocalDescription(await pc.createOffer());
  // Fertig sammeln oder (Sandbox ohne Abschluss) ein Kandidat und 2 s
  const started = Date.now();
  await until(() => pc.iceGatheringState === 'complete' || (/a=candidate/.test(pc.localDescription.sdp) && Date.now() - started > 2000));
  log('crossoffer', btoa(JSON.stringify(pc.localDescription)));
};
window.crossAnswer = async (answer) => {
  await window.crossPc.setRemoteDescription(JSON.parse(atob(answer)));
  log('crossanswered', window.crossPc.signalingState);
};
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

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
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

const query = new URLSearchParams({ relay: `ws://127.0.0.1:${RELAY_PORT}/wisp/`, token: TOKEN, url: siteURL });
await page.goto(`http://localhost:${UI_PORT}/?${query}`);
const err = () => results.get('error') || '';
check('RTCPeerConnection & Co. vorhanden', await result('api') === 'function,function,function,function', results.get('api'));
check('RTCIceCandidate zerlegt den Kandidaten', await result('candidate') === '192.0.2.1,54321,udp,host,rtp', results.get('candidate'));
check('createDataChannel sofort da', await result('channel', 30000) === 'chat,connecting,true,true', results.get('channel') || err());
check('Angebot (createOffer/setLocalDescription)', await result('offer', 30000) === 'have-local-offer,offer,true', results.get('offer') || err());
check('Antwort, beide stable', await result('answer', 30000) === 'stable,stable,answer', results.get('answer') || err());
check('DataChannel offen, negotiationneeded', /^open,chat,true,negotiation[1-9]/.test(await result('open', 30000) || ''), results.get('open') || err());
check('Nachrichten: Text, Bytes, Blob, Reihenfolge', await result('messages', 30000) === 'hallo|bin1.2.3|bin98.108.111.98|ende', results.get('messages') || err());
check('Antworten mit binaryType blob', await result('back', 30000) === 'zurueck|blob:bytes', results.get('back') || err());
check('connectionState connected', /^connected,connected,(gathering|complete)$/.test(await result('connected', 30000) || ''), results.get('connected') || err());
check('getStats', await result('stats', 30000) === 'true,true,true', results.get('stats') || err());
check('DataChannel close', await result('channelclosed', 30000) === 'closed,closed', results.get('channelclosed') || err());
check('close()', await result('closed', 30000) === 'closed,closed', results.get('closed') || err());

// Verbindung zu einer normalen Chromium-Seite
await page.evaluate(() => window.__blEval('window.crossConnect()'));
const offer = await result('crossoffer', 30000);
const peer = await context.newPage();
await peer.goto('about:blank');
const answer = offer ? await peer.evaluate(async (offer) => {
  const pc = window.pc = new RTCPeerConnection();
  window.received = [];
  pc.ondatachannel = (e) => {
    e.channel.onmessage = (m) => {
      window.received.push(m.data);
      e.channel.send('hallo von chromium');
    };
  };
  await pc.setRemoteDescription(JSON.parse(atob(offer)));
  await pc.setLocalDescription(await pc.createAnswer());
  const started = Date.now();
  while (pc.iceGatheringState !== 'complete' && !(/a=candidate/.test(pc.localDescription.sdp) && Date.now() - started > 2000))
    await new Promise((resolve) => setTimeout(resolve, 50));
  return btoa(JSON.stringify(pc.localDescription));
}, offer) : null;
if (answer)
  await page.evaluate((answer) => window.__blEval(`window.crossAnswer('${answer}')`), answer);
if (!offer)
  console.log('Host:', JSON.stringify(await page.evaluate(() => window.__blRtcState())));
check('Antwort von Chromium gesetzt', await result('crossanswered', 30000) === 'stable', results.get('crossanswered'));
check('Nachricht von Chromium angekommen', await result('crossmessage', 30000) === 'hallo_von_chromium', results.get('crossmessage'));
const received = await peer.evaluate(() => window.received?.join('|'));
check('Nachricht bei Chromium angekommen', received === 'hallo von browser-lite', received);

await browser.close();
relay.kill();
ui.kill();
site.close();
console.log(failed ? `${failed} Test(s) fehlgeschlagen` : 'Alle Tests ok');
process.exit(failed ? 1 : 0);
