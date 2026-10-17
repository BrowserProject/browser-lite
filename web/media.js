// <video>/<audio> der Seiten in der Engine abspielen.
//
// Fuer jeden Player der Engine (engine/src/media/) gibt es hier ein
// verstecktes <video>. Seine Daten kommen ueber den Service Worker (sw.js)
// von der Engine. Die Bilder kopieren wir in den WASM-Speicher, die Engine
// malt sie in die Seite. Der Ton kommt direkt aus diesem <video>.

import { captureTrack, captureApi } from './capture.js';
import { domError } from './util.js';

const players = new Map(); // id -> Player
const fetchSources = new Map(); // fetchId (Engine) -> { source, id (SW) }
let nextEngineFetchId = 1;
let engine = null;
let container = null;

// Muss im Dokument sein, sonst bremst Chrome versteckte Videos
function hiddenContainer() {
  if (!container) {
    container = document.createElement('div');
    container.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;overflow:hidden;opacity:0.01;pointer-events:none;z-index:-1';
    document.body.appendChild(container);
  }
  return container;
}

const STATE_EVENTS = ['loadedmetadata', 'durationchange', 'loadeddata', 'canplay', 'canplaythrough', 'playing', 'play',
  'pause', 'waiting', 'seeking', 'ended', 'progress', 'resize', 'stalled', 'emptied', 'ratechange', 'suspend'];

export async function initMedia(module) {
  engine = module;
  if (!('serviceWorker' in navigator))
    return;
  navigator.serviceWorker.addEventListener('message', onServiceWorkerMessage);
  try {
    await navigator.serviceWorker.register('sw.js', { scope: './' });
    // Beim ersten Besuch uebernimmt der Service Worker die Seite erst nach clients.claim()
    if (!navigator.serviceWorker.controller)
      await Promise.race([
        new Promise((resolve) => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true })),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
  } catch (error) {
    console.warn('Service Worker fuer Video nicht verfuegbar:', error);
  }
}

// -------------------------------------------------------------- Daten (SW)

function onServiceWorkerMessage(event) {
  const message = event.data;
  if (!message || !engine)
    return;
  if (message.bl === 'fetch') {
    const fetchId = nextEngineFetchId++;
    fetchSources.set(fetchId, { source: event.source, id: message.id });
    engine._bl_media_fetch(message.player, fetchId, message.start, message.end);
  } else if (message.bl === 'fetch-cancel') {
    for (const [fetchId, entry] of fetchSources) {
      if (entry.id === message.id && entry.source === event.source) {
        fetchSources.delete(fetchId);
        engine._bl_media_fetch_cancel(fetchId);
      }
    }
  }
}

export function onEngineMediaFetch(fetchId, type, data, bytes) {
  const entry = fetchSources.get(fetchId);
  if (!entry)
    return;
  if (type === 'end' || type === 'error')
    fetchSources.delete(fetchId);
  const message = { bl: 'fetch', id: entry.id, type, data };
  if (bytes) {
    message.bytes = bytes.buffer;
    entry.source.postMessage(message, [bytes.buffer]);
  } else {
    entry.source.postMessage(message);
  }
}

// ----------------------------------------------------------------- Player

class Player {
  constructor(id, options) {
    this.id = id;
    this.presentation = { width: 0, height: 0 };
    this.frames = 0; // an die Engine geschickte Bilder
    this.frameInFlight = false; // bis die Engine es mit "frame" uebernommen hat
    this.lastTime = -1;
    this.forceFrame = true;
    // Seite versteckt (Hintergrund-Tab): keine Bilder an die Engine, der Ton laeuft weiter
    this.hidden = !!options.hidden;

    const video = this.video = document.createElement('video');
    video.playsInline = true;
    video.preload = options.preload || 'auto';
    video.muted = !!options.muted;
    video.volume = Math.min(1, Math.max(0, options.volume ?? 1));
    video.playbackRate = options.rate || 1;
    for (const type of STATE_EVENTS)
      video.addEventListener(type, () => this.sendState(type));
    video.addEventListener('timeupdate', () => this.sendState('timeupdate'));
    video.addEventListener('seeked', () => {
      this.forceFrame = true;
      this.sendState('seeked');
    });
    video.addEventListener('loadeddata', () => { this.forceFrame = true; });
    video.addEventListener('error', () => {
      this.send({ type: 'error', code: video.error?.code || 4 });
    });
    hiddenContainer().appendChild(video);
    if (options.mse) {
      // MSE: eigenes MediaSource, die Daten schickt die Engine (SourceBufferPrivateWasm)
      this.mediaSource = new MediaSource();
      this.sourceBuffers = new Map(); // id der Engine -> SourceBuffer
      this.queue = []; // alle Operationen der Reihe nach
      this.mediaSource.addEventListener('sourceopen', () => this.runQueue(), { once: true });
      video.src = URL.createObjectURL(this.mediaSource);
    } else {
      video.src = `bl-media/${id}/${Date.now().toString(36)}`;
    }
    this.raf = requestAnimationFrame(() => this.pump());
  }

  send(object) {
    engine._bl_media_event(this.id, engine.stringToNewUTF8(JSON.stringify(object)));
  }

  sendState(type) {
    const video = this.video;
    const buffered = [];
    for (let i = 0; i < video.buffered.length; i++)
      buffered.push(video.buffered.start(i), video.buffered.end(i));
    const duration = video.duration;
    this.send({
      type,
      time: video.currentTime,
      // JSON kennt kein NaN/Infinity: -1 = unendlich (Live), weglassen = unbekannt
      duration: Number.isFinite(duration) ? duration : duration === Infinity ? -1 : undefined,
      width: video.videoWidth,
      height: video.videoHeight,
      hasVideo: video.videoWidth > 0,
      hasAudio: video.readyState >= 1,
      paused: video.paused,
      ended: video.ended,
      readyState: video.readyState,
      loading: video.networkState === HTMLMediaElement.NETWORK_LOADING,
      buffered,
    });
  }

  // ---------------------------------------------------------------- MSE
  // Eine Operation nach der anderen, jeweils erst wenn kein SourceBuffer mehr
  // beschaeftigt ist (wie es MSE verlangt).

  enqueue(operation) {
    this.queue.push(operation);
    this.runQueue();
  }

  busy() {
    for (const buffer of this.sourceBuffers.values()) {
      if (buffer.updating)
        return true;
    }
    return false;
  }

  runQueue() {
    const source = this.mediaSource;
    while (this.queue.length && source.readyState !== 'closed' && !this.busy()) {
      const operation = this.queue.shift();
      try {
        operation();
      } catch (error) {
        if (error.name === 'QuotaExceededError' && operation.retry) {
          // Voll: was weit hinter der aktuellen Zeit liegt wegwerfen, dann nochmal
          operation.retry = false;
          this.queue.unshift(operation);
          const end = Math.max(0, this.video.currentTime - 10);
          for (const buffer of this.sourceBuffers.values()) {
            if (end > 0 && !buffer.updating)
              buffer.remove(0, end);
          }
          if (end <= 0)
            this.queue.shift();
          return;
        }
        console.warn('MSE im Host:', error);
      }
    }
  }

  mseCommand(type, data, bytes) {
    const fromTime = (value) => (value === -1 ? Infinity : value);
    switch (type) {
    case 'sb-add':
      this.enqueue(() => {
        const buffer = this.mediaSource.addSourceBuffer(data.type);
        buffer.addEventListener('updateend', () => this.runQueue());
        buffer.addEventListener('error', () => console.warn('SourceBuffer-Fehler im Host'));
        this.sourceBuffers.set(data.sb, buffer);
      });
      return true;
    case 'sb-append': {
      const operation = () => {
        const buffer = this.sourceBuffers.get(data.sb);
        if (!buffer)
          return;
        if (buffer.timestampOffset !== data.offset)
          buffer.timestampOffset = data.offset;
        const windowEnd = fromTime(data.windowEnd);
        if (buffer.appendWindowStart !== data.windowStart || buffer.appendWindowEnd !== windowEnd) {
          buffer.appendWindowStart = 0;
          buffer.appendWindowEnd = windowEnd;
          buffer.appendWindowStart = data.windowStart;
        }
        buffer.appendBuffer(bytes);
      };
      operation.retry = true;
      this.enqueue(operation);
      return true;
    }
    case 'sb-abort':
      this.enqueue(() => {
        const buffer = this.sourceBuffers.get(data.sb);
        if (buffer && this.mediaSource.readyState === 'open')
          buffer.abort();
      });
      return true;
    case 'sb-remove':
      this.enqueue(() => {
        const buffer = this.sourceBuffers.get(data.sb);
        const source = this.mediaSource;
        // Bei "ended" setzt remove() das MediaSource selber wieder auf "open"
        if (!buffer || source.readyState === 'closed' || Number.isNaN(source.duration))
          return;
        // Wie in WebCore: nicht ueber die Dauer hinaus
        const start = Math.min(data.start, source.duration);
        const end = fromTime(data.end);
        if (end > start)
          buffer.remove(start, end);
      });
      return true;
    case 'sb-type':
      this.enqueue(() => this.sourceBuffers.get(data.sb)?.changeType(data.type));
      return true;
    case 'sb-remove-buffer':
      this.enqueue(() => {
        const buffer = this.sourceBuffers.get(data.sb);
        this.sourceBuffers.delete(data.sb);
        if (buffer)
          this.mediaSource.removeSourceBuffer(buffer);
      });
      return true;
    case 'ms-duration':
      this.enqueue(() => {
        if (this.mediaSource.readyState === 'open')
          this.mediaSource.duration = fromTime(data.duration);
      });
      return true;
    case 'ms-eos':
      this.enqueue(() => {
        if (this.mediaSource.readyState === 'open')
          this.mediaSource.endOfStream(data.error || undefined);
      });
      return true;
    }
    return false;
  }

  command(type, data, bytes) {
    if (this.mediaSource && this.mseCommand(type, data, bytes))
      return;
    const video = this.video;
    switch (type) {
    case 'play':
      video.play().catch(() => this.sendState('pause'));
      break;
    case 'pause':
      video.pause();
      break;
    case 'seek':
      if (video.readyState === 0) {
        // Noch keine Daten: Chrome merkt sich die Zeit, ein seeked kommt nicht
        video.currentTime = data.time;
        this.send({ type: 'seeked', time: data.time });
      } else {
        video.currentTime = data.time;
      }
      break;
    case 'rate':
      video.playbackRate = data.rate || 1;
      break;
    case 'volume':
      video.volume = Math.min(1, Math.max(0, data.volume));
      break;
    case 'muted':
      video.muted = data.muted;
      break;
    case 'pitch':
      video.preservesPitch = data.preservesPitch;
      break;
    case 'frame':
      this.frameInFlight = false;
      break;
    case 'visible':
      this.hidden = !data.visible;
      this.forceFrame = true;
      break;
    case 'preload':
      // Ein hoeherer Wert gilt in Chrome von selber, load() wuerde neu anfangen
      video.preload = data.preload;
      break;
    case 'size':
      this.presentation = { width: data.width, height: data.height };
      this.forceFrame = true;
      break;
    }
  }

  // Groesse der Bilder: so gross wie auf dem Bildschirm, hoechstens wie das Video
  frameSize() {
    const video = this.video;
    let width = video.videoWidth;
    let height = video.videoHeight;
    const target = this.presentation.width * devicePixelRatio;
    if (target > 0 && target < width) {
      height = Math.max(1, Math.round(height * target / width));
      width = Math.max(1, Math.round(target));
    }
    return [width, height];
  }

  pump() {
    this.raf = requestAnimationFrame(() => this.pump());
    const video = this.video;
    if (this.hidden || video.readyState < 2 || !video.videoWidth || this.frameInFlight)
      return;
    if (video.currentTime === this.lastTime && !this.forceFrame)
      return;
    this.lastTime = video.currentTime;
    this.forceFrame = false;
    this.copyFrame();
  }

  // Jedes Bild in einen eigenen Puffer, den die Engine uebernimmt und freigibt
  // (MediaPlayerPrivateWasm::hostFrame). Wir fassen ihn danach nie wieder an.
  copyFrame() {
    const [width, height] = this.frameSize();
    if (!this.canvas || this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas = new OffscreenCanvas(width, height);
      this.ctx = this.canvas.getContext('2d', { alpha: false, willReadFrequently: true });
    }
    this.ctx.drawImage(this.video, 0, 0, width, height);
    const pixels = this.ctx.getImageData(0, 0, width, height).data;
    const ptr = engine._malloc(pixels.length);
    if (!ptr)
      return;
    engine.HEAPU8.set(pixels, ptr);
    this.frameInFlight = true;
    this.frames++;
    engine._bl_media_frame(this.id, ptr, width, height);
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    const video = this.video;
    video.pause();
    if (this.mediaSource)
      URL.revokeObjectURL(video.src);
    video.removeAttribute('src');
    video.load();
    video.remove();
  }
}

export function onEngineMedia(id, type, data, bytes) {
  if (type === 'create') {
    players.get(id)?.destroy();
    players.set(id, new Player(id, data));
    return;
  }
  const player = players.get(id);
  if (!player)
    return;
  if (type === 'destroy') {
    player.destroy();
    players.delete(id);
    return;
  }
  player.command(type, data, bytes);
}

// Fuer Tests
export function mediaState() {
  return [...players.values()].map((p) => {
    const ranges = [];
    for (let i = 0; i < p.video.buffered.length; i++)
      ranges.push([p.video.buffered.start(i), p.video.buffered.end(i)]);
    return { id: p.id, time: p.video.currentTime, paused: p.video.paused, width: p.video.videoWidth, frames: p.frames, preload: p.video.preload, buffered: ranges };
  });
}

// ------------------------------------------------------- Picture-in-Picture
// Das versteckte <video> des Players geht ins PiP-Fenster von Chrome
// (engine/src/WebRTCPolyfill.cpp). Ereignisse holt die Seite mit "pip-wait".

const pipQueues = new Map(); // Player-Id -> { events, wake }

function pipQueue(id) {
  let queue = pipQueues.get(id);
  if (!queue) {
    queue = { events: [], wake: null };
    pipQueues.set(id, queue);
  }
  return queue;
}

function pipPush(id, event) {
  const queue = pipQueue(id);
  queue.events.push(event);
  queue.wake?.();
}

// srcObject-Streams haben keinen Player: eigenes verstecktes <video> mit der
// Spur (Kamera: Kopie der echten Spur, sonst schreibt die Engine-Senke in
// einen MediaStreamTrackGenerator). Ids negativ, damit sie nicht mit Playern
// zusammenfallen
const streamPips = new Map(); // id -> { video, track, origin }
let nextStreamPip = -1;

function closeStreamPip(id) {
  const pip = streamPips.get(id);
  if (!pip)
    return;
  streamPips.delete(id);
  pip.track.stop();
  pip.video.srcObject = null;
  pip.video.remove();
}

async function enterStreamPip(info, origin) {
  if (!info || info.kind !== 'video')
    throw domError('NotSupportedError', 'Picture-in-Picture is not available for this video.');
  let track;
  if (info.capture) {
    const original = await captureTrack(info.capture);
    if (!original || original.readyState === 'ended')
      throw domError('InvalidStateError', 'The track has ended.');
    track = original.clone();
  } else if (info.sink && typeof MediaStreamTrackGenerator === 'function') {
    const worker = captureApi()?.engineWorker();
    if (!worker)
      throw domError('InvalidStateError', 'No engine');
    track = new MediaStreamTrackGenerator({ kind: 'video' });
    worker.postMessage({ blSink: { id: info.sink, writable: track.writable } }, [track.writable]);
  } else
    throw domError('NotSupportedError', 'Picture-in-Picture is not available for this video.');
  const id = nextStreamPip--;
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = new MediaStream([track]);
  hiddenContainer().appendChild(video);
  streamPips.set(id, { video, track, origin });
  try {
    if (video.readyState < 1)
      await new Promise((resolve, reject) => {
        video.addEventListener('loadedmetadata', resolve, { once: true });
        setTimeout(() => reject(domError('InvalidStateError', 'The video has no frames.')), 5000);
      });
    await video.play().catch(() => {});
    video.addEventListener('leavepictureinpicture', () => {
      pipPush(id, { type: 'leave' });
      closeStreamPip(id);
    }, { once: true });
    track.addEventListener('ended', () => {
      if (document.pictureInPictureElement === video)
        document.exitPictureInPicture().catch(() => {});
    });
    pipQueue(id).events.length = 0;
    const pipWindow = await video.requestPictureInPicture();
    pipWindow.addEventListener('resize', () => pipPush(id, { type: 'resize', width: pipWindow.width, height: pipWindow.height }));
    return { stream: id, width: pipWindow.width, height: pipWindow.height };
  } catch (e) {
    closeStreamPip(id);
    throw e;
  }
}

async function enterPlayerPip(payload) {
  const id = Number(payload?.player);
  const player = players.get(id);
  if (!player)
    throw domError('InvalidStateError', 'The video is gone.');
  if (!document.pictureInPictureEnabled)
    throw domError('NotSupportedError', 'Picture-in-Picture is disabled.');
  const video = player.video;
  if (!player.pipHooked) {
    player.pipHooked = true;
    video.addEventListener('leavepictureinpicture', () => pipPush(id, { type: 'leave' }));
  }
  pipQueue(id).events.length = 0;
  const pipWindow = await video.requestPictureInPicture();
  pipWindow.addEventListener('resize', () => pipPush(id, { type: 'resize', width: pipWindow.width, height: pipWindow.height }));
  return { width: pipWindow.width, height: pipWindow.height };
}

let pipView = 0; // Tab mit dem PiP-Fenster (Chrome hat hoechstens eines)

// Tab, dessen Video gerade im PiP-Fenster ist, sonst 0
export function pictureInPictureView() {
  return document.pictureInPictureElement ? pipView : 0;
}

export const pipHostCalls = {
  async 'pip-enter'(payload, origin, view) {
    const result = await (payload?.track ? enterStreamPip(payload.track, origin) : enterPlayerPip(payload));
    pipView = view;
    return result;
  },
  async 'pip-exit'() {
    if (document.pictureInPictureElement)
      await document.exitPictureInPicture();
    return {};
  },
  async 'pip-wait'(payload) {
    const id = Number(payload?.player);
    const queue = pipQueue(id);
    if (!queue.events.length) {
      await new Promise((resolve) => {
        queue.wake = resolve;
        setTimeout(resolve, 20000);
      });
      queue.wake = null;
    }
    // Player weg: das PiP-Fenster ist zu
    if (id < 0 ? !streamPips.has(id) && !queue.events.length : !players.has(id))
      return { type: 'leave' };
    return queue.events.shift() ?? { type: 'none' };
  },
};
