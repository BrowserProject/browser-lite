// Kamera, Mikrofon und Bildschirm fuer die Seiten in der Engine
// (engine/src/media/MediaStreamWasm.cpp). Startet eine Quelle der Engine,
// oeffnen wir das Geraet des Host-Browsers und geben die Bilder/den Ton als
// ReadableStream (MediaStreamTrackProcessor) direkt an den Engine-Worker
// (engine/js/webcodecs-host.js). Gefragt hat die Engine vorher schon.

let api; // { engine(), engineWorker() }

export function initCapture(options) {
  api = options;
}

const captures = new Map(); // id -> { stream, track } (stream null = startet noch)

function constraint(value) {
  return value ? { ideal: value } : undefined;
}

async function openHostDevice(data) {
  if (data.kind === 'screen')
    return navigator.mediaDevices.getDisplayMedia({ video: { frameRate: constraint(data.frameRate) }, audio: false });
  if (data.kind === 'camera')
    return navigator.mediaDevices.getUserMedia({ video: { width: constraint(data.width), height: constraint(data.height), frameRate: constraint(data.frameRate) } });
  return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: data.echoCancellation !== false } });
}

export async function onCaptureStart(data) {
  onCaptureStop(data);
  const entry = { stream: null, track: null };
  // Fuer WebRTC: wartet, bis die Host-Spur offen ist (null = fehlgeschlagen)
  entry.ready = new Promise((resolve) => entry.resolve = resolve);
  captures.set(data.id, entry);
  const engine = api.engine();
  try {
    if (!navigator.mediaDevices)
      throw new Error('Keine Geraete');
    const stream = await openHostDevice(data);
    if (captures.get(data.id) !== entry) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    const track = data.kind === 'microphone' ? stream.getAudioTracks()[0] : stream.getVideoTracks()[0];
    const worker = api.engineWorker();
    if (!track || !worker || typeof MediaStreamTrackProcessor !== 'function')
      throw new Error('MediaStreamTrackProcessor fehlt');
    entry.stream = stream;
    entry.track = track;
    entry.resolve(track);
    // z.B. "Freigabe beenden" in Chrome
    track.addEventListener('ended', () => {
      if (captures.get(data.id) !== entry)
        return;
      captures.delete(data.id);
      engine._bl_capture_ended(data.id);
    });
    const processor = new MediaStreamTrackProcessor({ track });
    worker.postMessage({ blCapture: { id: data.id, kind: data.kind === 'microphone' ? 'audio' : 'video', readable: processor.readable } }, [processor.readable]);
  } catch (error) {
    if (captures.get(data.id) === entry)
      captures.delete(data.id);
    console.warn('[capture]', data.kind, error?.message || error);
    entry.resolve(null);
    engine._bl_capture_failed(data.id);
  }
}

export function onCaptureStop(data) {
  const entry = captures.get(data.id);
  if (!entry)
    return;
  captures.delete(data.id);
  entry.stream?.getTracks().forEach((track) => track.stop());
  api.engineWorker()?.postMessage({ blCapture: { id: data.id } });
}

// Fuer WebRTC (web/webrtc.js): die echte Host-Spur einer Aufnahme der Engine
export async function captureTrack(id) {
  const entry = captures.get(id);
  return entry ? (entry.track ?? await entry.ready) : null;
}

export function captureApi() {
  return api;
}
