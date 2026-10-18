// WebRTC (engine/src/WebRTCPolyfill.cpp, the opt-in webrtc service of the core): two
// RTCPeerConnections in the page (offer/answer, ICE, DataChannel with text, binary and blob,
// states, getStats, close) and a connection between browser-lite and a normal Chromium page.
// Media: canvas and Web Audio in a loopback (picture and sound arrive), the camera in both
// directions with a Chromium page. The polyfill also applies in the initial document of a frame.
//
//   node tests/core/webrtc-test.mjs [engine-dir]
import {
  SWIFTSHADER,
  TIMEOUT,
  canvasOrigin,
  check,
  collect,
  finish,
  launch,
  openHost,
  serve,
  startStack,
  timeLimit,
} from '../lib/index.mjs';

timeLimit();

const PAGE = `<!doctype html><title>WebRTC test</title>
<style>body { margin: 0 } #cam { position: absolute; left: 20px; top: 20px; width: 200px; height: 60px; }</style>
<button id="cam">Camera on</button>
<script>
const log = (key, value) => console.log('RESULT ' + key + '=' + String(value).replace(/\\s/g, '_'));
const until = (condition, ms = 20000) => new Promise((resolve, reject) => {
  const end = Date.now() + ms;
  const check = () => condition() ? resolve() : Date.now() > end ? reject(new Error('Zeitlimit')) : setTimeout(check, 20);
  check();
});
log('api', [typeof RTCPeerConnection, typeof RTCSessionDescription, typeof RTCIceCandidate, typeof RTCDataChannel].join(','));
// Empty initial document of a frame that still loads: polyfill there, bridges gone
const loading = document.createElement('iframe');
loading.src = '/langsam';
document.body.append(loading);
log('initial', typeof loading.contentWindow.RTCPeerConnection + ',' + (['__blHost', '__blMedia', '__blExtendPrototype'].filter((name) => name in loading.contentWindow).join('+') || 'none'));
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
    channel.send('hello');
    channel.send(new Uint8Array([1, 2, 3]));
    channel.send(new Blob(['blob']));
    channel.send('end');
    await until(() => messages.length === 4);
    log('messages', messages.join('|'));
    const back = [];
    channel.binaryType = 'blob';
    channel.onmessage = async (e) => back.push(typeof e.data === 'string' ? e.data : (e.data instanceof Blob ? 'blob:' + await e.data.text() : 'anders'));
    remote.send('back');
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
    window.mediaLoopback();
  } catch (e) {
    log('error', e.name + ':' + e.message);
  }
})();
const waitGathering = async (pc) => {
  const started = Date.now();
  await until(() => pc.iceGatheringState === 'complete' || (/a=candidate/.test(pc.localDescription.sdp) && Date.now() - started > 2000));
};
const colorOf = (video) => {
  const canvas = document.createElement('canvas');
  canvas.width = 16;
  canvas.height = 12;
  const context = canvas.getContext('2d');
  context.drawImage(video, 0, 0, 16, 12);
  return [...context.getImageData(8, 6, 1, 1).data.slice(0, 3)];
};
// Media in a loopback: a red canvas and 440 Hz from Web Audio
window.mediaLoopback = async () => {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 160;
    canvas.height = 120;
    const context = canvas.getContext('2d');
    const draw = () => {
      context.fillStyle = 'rgb(255, 0, 0)';
      context.fillRect(0, 0, 160, 120);
    };
    draw();
    const timer = setInterval(draw, 50);
    const audioContext = new AudioContext();
    const oscillator = audioContext.createOscillator();
    const destination = audioContext.createMediaStreamDestination();
    oscillator.connect(destination);
    oscillator.start();
    await audioContext.resume();
    const local = new MediaStream([canvas.captureStream(20).getVideoTracks()[0], destination.stream.getAudioTracks()[0]]);
    const a = new RTCPeerConnection(), b = new RTCPeerConnection();
    a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate);
    b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate);
    const kinds = [];
    let remote = null;
    b.ontrack = (e) => {
      kinds.push(e.track.kind + ':' + (e.track instanceof MediaStreamTrack) + ':' + (e.transceiver.receiver === e.receiver));
      remote = e.streams[0];
    };
    local.getTracks().forEach((track) => a.addTrack(track, local));
    log('senders', a.getSenders().length + ',' + a.getTransceivers().map((t) => t.direction).join('/') + ',' + (a.getSenders()[0].track === local.getTracks()[0]));
    await a.setLocalDescription(await a.createOffer());
    await b.setRemoteDescription(a.localDescription);
    await b.setLocalDescription(await b.createAnswer());
    await a.setRemoteDescription(b.localDescription);
    await until(() => kinds.length === 2);
    log('tracks', kinds.sort().join(',') + ',' + (remote instanceof MediaStream && remote.id === local.id) + ',' + b.getReceivers().length + ',' + a.getTransceivers().map((t) => t.mid).join('/'));
    const video = document.createElement('video');
    video.muted = true;
    video.srcObject = remote;
    await video.play();
    await until(() => video.videoWidth > 0, 30000);
    await until(() => { const [r, g] = colorOf(video); return r > 150 && g < 100; }, 20000).catch(() => {});
    log('remotevideo', video.videoWidth + 'x' + video.videoHeight + ',' + colorOf(video).join('.'));
    const analyser = audioContext.createAnalyser();
    audioContext.createMediaStreamSource(remote).connect(analyser);
    let peak = 0;
    await until(() => {
      const data = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(data);
      for (const value of data)
        peak = Math.max(peak, Math.abs(value));
      return peak > 0.05;
    }, 20000).catch(() => {});
    if (peak <= 0.05) {
      const sent = [...(await a.getStats()).values()].filter((s) => s.type === 'outbound-rtp').map((s) => s.kind + ':' + s.packetsSent).join('/');
      const received = [...(await b.getStats()).values()].filter((s) => s.type === 'inbound-rtp').map((s) => s.kind + ':' + s.packetsReceived).join('/');
      log('audiodebug', sent + '|' + received + '|' + remote.getAudioTracks().map((t) => t.readyState + ':' + t.muted + ':' + t.enabled).join());
    }
    log('remoteaudio', peak > 0.05 ? 'sound' : 'silent' + peak);
    const stats = await a.getSenders()[0].getStats();
    log('senderstats', [...stats.values()].some((s) => s.type === 'outbound-rtp'));
    a.close();
    b.close();
    // The same track in a new connection (the sink is connected again)
    const c = new RTCPeerConnection(), d = new RTCPeerConnection();
    c.onicecandidate = (e) => e.candidate && d.addIceCandidate(e.candidate);
    d.onicecandidate = (e) => e.candidate && c.addIceCandidate(e.candidate);
    const again = new Promise((resolve) => d.ontrack = (e) => resolve(e.track));
    c.addTrack(local.getVideoTracks()[0], local);
    await c.setLocalDescription(await c.createOffer());
    await d.setRemoteDescription(c.localDescription);
    await d.setLocalDescription(await d.createAnswer());
    await c.setRemoteDescription(d.localDescription);
    const second = document.createElement('video');
    second.muted = true;
    second.srcObject = new MediaStream([await again]);
    await second.play();
    await until(() => second.videoWidth > 0, 30000).catch(() => {});
    log('reuse', second.videoWidth + 'x' + second.videoHeight);
    c.close();
    d.close();
    clearInterval(timer);
    log('medialoop', 'fertig');
  } catch (e) {
    log('mediaerror', e.name + ':' + e.message);
  }
};
// Send the camera to a Chromium page and receive its camera
document.getElementById('cam').addEventListener('click', async () => {
  try {
    window.camStream = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240 } });
    log('cam', window.camStream.getVideoTracks().length);
  } catch (e) {
    log('cam', e.name);
  }
});
window.camConnect = async () => {
  const pc = window.camPc = new RTCPeerConnection();
  window.camStream.getTracks().forEach((track) => pc.addTrack(track, window.camStream));
  pc.ontrack = async (e) => {
    const video = document.createElement('video');
    video.muted = true;
    video.srcObject = e.streams[0] || new MediaStream([e.track]);
    await video.play();
    await until(() => video.videoWidth > 0, 30000).catch(() => {});
    log('camreceived', video.videoWidth + 'x' + video.videoHeight);
  };
  await pc.setLocalDescription(await pc.createOffer());
  await waitGathering(pc);
  log('camoffer', btoa(JSON.stringify(pc.localDescription)));
};
window.camAnswer = async (answer) => {
  await window.camPc.setRemoteDescription(JSON.parse(atob(answer)));
  log('camanswered', window.camPc.signalingState);
};
// Peer outside: an offer without trickle ICE (all candidates in the SDP)
window.crossConnect = async () => {
  const pc = window.crossPc = new RTCPeerConnection();
  const channel = window.crossChannel = pc.createDataChannel('kreuz');
  channel.onmessage = (e) => log('crossmessage', e.data);
  channel.onopen = () => channel.send('hello from browser-lite');
  await pc.setLocalDescription(await pc.createOffer());
  // Gather completely or (sandbox without completion) one candidate and 2 s
  const started = Date.now();
  await until(() => pc.iceGatheringState === 'complete' || (/a=candidate/.test(pc.localDescription.sdp) && Date.now() - started > 2000));
  log('crossoffer', btoa(JSON.stringify(pc.localDescription)));
};
window.crossAnswer = async (answer) => {
  await window.crossPc.setRemoteDescription(JSON.parse(atob(answer)));
  log('crossanswered', window.crossPc.signalingState);
};
</script>`;

const { url: siteURL } = await serve((req, res) => {
  if (req.url === '/langsam') {
    setTimeout(() => res.writeHead(200, { 'Content-Type': 'text/html' }).end('langsam'), 2000);
    return;
  }
  res
    .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    .end(req.url === '/blank' ? '<!doctype html><title>Peer</title>' : PAGE);
});

const stack = await startStack({ token: 'webrtc-token-0123456789abcdef' });
const browser = await launch({
  args: [
    ...SWIFTSHADER,
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const context = await browser.newContext({
  viewport: { width: 1000, height: 700 },
  permissions: ['camera', 'microphone'],
});
const page = await context.newPage();
const results = collect(page);
const result = (key, ms = TIMEOUT) => results.wait(key, ms, () => results.has('error'));

// WebRTC is opt-in: the default services plus webrtc()
await openHost(page, stack.app({ url: siteURL, services: 'default,webrtc' }));
await page.evaluate(() => {
  window.blHost.permissionAnswer = 'grant';
});
const err = () => results.get('error') || '';
check(
  'RTCPeerConnection and friends there',
  (await result('api')) === 'function,function,function,function',
  results.get('api'),
);
check(
  'frame that still loads: polyfill there, bridges not',
  (await result('initial')) === 'function,none',
  results.get('initial'),
);
check(
  'RTCIceCandidate parses the candidate',
  (await result('candidate')) === '192.0.2.1,54321,udp,host,rtp',
  results.get('candidate'),
);
check(
  'createDataChannel there right away',
  (await result('channel', 30000)) === 'chat,connecting,true,true',
  results.get('channel') || err(),
);
check(
  'offer (createOffer/setLocalDescription)',
  (await result('offer', 30000)) === 'have-local-offer,offer,true',
  results.get('offer') || err(),
);
check(
  'answer, both stable',
  (await result('answer', 30000)) === 'stable,stable,answer',
  results.get('answer') || err(),
);
check(
  'DataChannel open, negotiationneeded',
  /^open,chat,true,negotiation[1-9]/.test((await result('open', 30000)) || ''),
  results.get('open') || err(),
);
check(
  'messages: text, bytes, blob, order',
  (await result('messages', 30000)) === 'hello|bin1.2.3|bin98.108.111.98|end',
  results.get('messages') || err(),
);
check(
  'answers with binaryType blob',
  (await result('back', 30000)) === 'back|blob:bytes',
  results.get('back') || err(),
);
check(
  'connectionState connected',
  /^connected,connected,(gathering|complete)$/.test((await result('connected', 30000)) || ''),
  results.get('connected') || err(),
);
check(
  'getStats',
  (await result('stats', 30000)) === 'true,true,true',
  results.get('stats') || err(),
);
check(
  'DataChannel close',
  (await result('channelclosed', 30000)) === 'closed,closed',
  results.get('channelclosed') || err(),
);
check(
  'close()',
  (await result('closed', 30000)) === 'closed,closed',
  results.get('closed') || err(),
);

// Media in a loopback
const mediaErr = () => results.get('mediaerror') || '';
check(
  'addTrack: sender and transceiver',
  (await result('senders', 30000)) === '2,sendrecv/sendrecv,true',
  results.get('senders') || mediaErr(),
);
check(
  'ontrack with tracks and stream (id as sent)',
  (await result('tracks', 30000)) === 'audio:true:true,video:true:true,true,2,0/1',
  results.get('tracks') || mediaErr(),
);
check(
  'picture arrives (red canvas)',
  /^160x120,(2[0-9][0-9]|1[6-9][0-9])\.[0-9]{1,2}\./.test(
    (await result('remotevideo', 60000)) || '',
  ),
  results.get('remotevideo') || mediaErr(),
);
check(
  'sound arrives (Web Audio)',
  (await result('remoteaudio', 30000)) === 'sound',
  results.get('remoteaudio') || mediaErr(),
);
check(
  'sender.getStats',
  (await result('senderstats', 30000)) === 'true',
  results.get('senderstats') || mediaErr(),
);
check(
  'track after close() in a new connection',
  (await result('reuse', 60000)) === '160x120',
  results.get('reuse') || mediaErr(),
);
await result('medialoop', 30000);

// Connection to a normal Chromium page
await page.evaluate(() => window.blTest.eval('window.crossConnect()'));
const offer = await result('crossoffer', 30000);
const peer = await context.newPage();
await peer.goto(siteURL + 'blank');
const answer = offer
  ? await peer.evaluate(async (offer) => {
      const pc = (window.pc = new RTCPeerConnection());
      window.received = [];
      pc.ondatachannel = (e) => {
        e.channel.onmessage = (m) => {
          window.received.push(m.data);
          e.channel.send('hello from chromium');
        };
      };
      await pc.setRemoteDescription(JSON.parse(atob(offer)));
      await pc.setLocalDescription(await pc.createAnswer());
      const started = Date.now();
      while (
        pc.iceGatheringState !== 'complete' &&
        !(/a=candidate/.test(pc.localDescription.sdp) && Date.now() - started > 2000)
      )
        await new Promise((resolve) => setTimeout(resolve, 50));
      return btoa(JSON.stringify(pc.localDescription));
    }, offer)
  : null;
if (answer)
  await page.evaluate((answer) => window.blTest.eval(`window.crossAnswer('${answer}')`), answer);
if (!offer)
  console.log('Host:', JSON.stringify(await page.evaluate(() => window.blTest.rtcState())));
check(
  'answer from Chromium set',
  (await result('crossanswered', 30000)) === 'stable',
  results.get('crossanswered'),
);
check(
  'message from Chromium arrived',
  (await result('crossmessage', 30000)) === 'hello_from_chromium',
  results.get('crossmessage'),
);
const received = await peer.evaluate(() => window.received?.join('|'));
check('message arrived at Chromium', received === 'hello from browser-lite', received);

// Camera from browser-lite to Chromium and back
const box = await canvasOrigin(page);
await page.bringToFront();
await page.mouse.click(box.x + 120, box.y + 50);
check('camera in browser-lite', (await result('cam', 30000)) === '1', results.get('cam'));
await page.evaluate(() => window.blTest.eval('window.camConnect()'));
const camOffer = await result('camoffer', 30000);
const camAnswer = camOffer
  ? await peer.evaluate(async (offer) => {
      const pc = (window.camPc = new RTCPeerConnection());
      window.camSize = '';
      pc.ontrack = async (e) => {
        const video = document.createElement('video');
        video.muted = true;
        video.srcObject = e.streams[0];
        await video.play();
        const end = Date.now() + 30000;
        while (!video.videoWidth && Date.now() < end)
          await new Promise((resolve) => setTimeout(resolve, 100));
        window.camSize = video.videoWidth + 'x' + video.videoHeight;
      };
      await pc.setRemoteDescription(JSON.parse(atob(offer)));
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480 },
      });
      stream.getTracks().forEach((track) => pc.addTrack(track, stream));
      await pc.setLocalDescription(await pc.createAnswer());
      const started = Date.now();
      while (
        pc.iceGatheringState !== 'complete' &&
        !(/a=candidate/.test(pc.localDescription.sdp) && Date.now() - started > 2000)
      )
        await new Promise((resolve) => setTimeout(resolve, 50));
      return btoa(JSON.stringify(pc.localDescription));
    }, camOffer)
  : null;
if (camAnswer)
  await page.evaluate((answer) => window.blTest.eval(`window.camAnswer('${answer}')`), camAnswer);
check(
  'camera answer set',
  (await result('camanswered', 30000)) === 'stable',
  results.get('camanswered'),
);
// WebRTC starts smaller depending on the bandwidth estimate: only check that a picture is there
check(
  'browser-lite receives the camera of Chromium',
  /^[1-9]\d*x[1-9]\d*$/.test((await result('camreceived', 60000)) || ''),
  results.get('camreceived'),
);
let camSize = '';
for (let i = 0; i < 60 && !camSize; i++) {
  camSize = await peer.evaluate(() => window.camSize);
  await new Promise((resolve) => setTimeout(resolve, 500));
}
check('Chromium receives the camera of browser-lite', /^[1-9]\d*x[1-9]\d*$/.test(camSize), camSize);

await browser.close();
finish();
