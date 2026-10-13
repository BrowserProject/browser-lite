// MediaRecorder der Seiten (engine/src/media/MediaRecorderWasm.cpp), Host-Seite.
//
// Laeuft im Engine-Worker (--pre-js), aufgerufen nur im Engine-Thread. Bild und
// Ton kommen roh aus der Engine, ein VideoEncoder/AudioEncoder des Host kodiert
// sie (VP8, VP9, AV1, Opus) und wir schreiben daraus WebM wie Chrome: Segment
// und Cluster mit unbekannter Laenge, SimpleBlocks, neuer Cluster bei jedem
// Video-Schluesselbild. Die Engine holt die fertigen Bytes mit take().
var blRecorder = (function () {
  'use strict';
  const VIDEO_FORMATS = ['I420', 'I420A', 'I422', 'I444', 'NV12', 'RGBA', 'RGBX', 'BGRA', 'BGRX'];
  const VIDEO_CODECS = {
    vp8: { codec: 'vp8', id: 'V_VP8' },
    vp9: { codec: 'vp09.00.10.08', id: 'V_VP9' },
    av1: { codec: 'av01.0.04M.08', id: 'V_AV1' },
  };
  const KEYFRAME_INTERVAL = 2e6; // us, wie oft ein Schluesselbild (Springen im Video)

  // ---------------------------------------------------------------- EBML
  const encoder = new TextEncoder();
  function concat(parts) {
    let size = 0;
    for (const part of parts)
      size += part.length;
    const out = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }
  function idBytes(id) {
    const bytes = [];
    for (let value = id; value > 0; value = Math.floor(value / 256))
      bytes.unshift(value & 255);
    return Uint8Array.from(bytes);
  }
  function sizeBytes(size) {
    for (let length = 1; length <= 8; length++) {
      if (size < 2 ** (7 * length) - 1) {
        const bytes = new Uint8Array(length);
        let value = size;
        for (let i = length - 1; i >= 0; i--) {
          bytes[i] = value % 256;
          value = Math.floor(value / 256);
        }
        bytes[0] |= 1 << (8 - length);
        return bytes;
      }
    }
    throw new Error('EBML: zu gross');
  }
  const UNKNOWN_SIZE = Uint8Array.from([0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]);
  const element = (id, payload) => concat([idBytes(id), sizeBytes(payload.length), payload]);
  const master = (id, children) => element(id, concat(children));
  function uint(id, value) {
    const bytes = [];
    for (let v = value; v > 0; v = Math.floor(v / 256))
      bytes.unshift(v % 256);
    return element(id, Uint8Array.from(bytes.length ? bytes : [0]));
  }
  function float(id, value) {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setFloat64(0, value);
    return element(id, bytes);
  }
  const string = (id, value) => element(id, encoder.encode(value));

  function opusHead(channels, sampleRate) {
    const head = new Uint8Array(19);
    head.set(encoder.encode('OpusHead'));
    const view = new DataView(head.buffer);
    view.setUint8(8, 1);
    view.setUint8(9, channels);
    view.setUint16(10, 312, true); // pre-skip wie libopus bei 48 kHz
    view.setUint32(12, sampleRate, true);
    return head;
  }

  // ---------------------------------------------------------------- Muxer
  function writeHeader(state) {
    const entries = [];
    for (const track of state.tracks) {
      const children = [uint(0xD7, track.number), uint(0x73C5, track.number), uint(0x83, track.kind === 'video' ? 1 : 2), string(0x86, track.codecId)];
      if (track.kind === 'video') {
        if (track.description)
          children.push(element(0x63A2, track.description));
        children.push(master(0xE0, [uint(0xB0, track.width || 1), uint(0xBA, track.height || 1)]));
      } else {
        children.push(element(0x63A2, track.description || opusHead(track.channels || 2, track.sampleRate || 48000)));
        children.push(uint(0x56AA, 6500000), uint(0x56BB, 80000000));
        children.push(master(0xE1, [float(0xB5, 48000), uint(0x9F, track.channels || 2)]));
      }
      entries.push(master(0xAE, children));
    }
    const ebml = master(0x1A45DFA3, [uint(0x4286, 1), uint(0x42F7, 1), uint(0x42F2, 4), uint(0x42F3, 8), string(0x4282, 'webm'), uint(0x4287, 4), uint(0x4285, 2)]);
    const info = master(0x1549A966, [uint(0x2AD7B1, 1000000), string(0x4D80, 'browser-lite'), string(0x5741, 'browser-lite')]);
    state.out.push(ebml, concat([idBytes(0x18538067), UNKNOWN_SIZE]), info, master(0x1654AE6B, entries));
    state.headerWritten = true;
  }

  function writeBlock(state, block) {
    const ms = Math.round(block.timestamp / 1000);
    if (state.firstMs === null)
      state.firstMs = ms;
    const relative = ms - (state.clusterMs === null ? 0 : state.clusterMs);
    const newCluster = state.clusterMs === null || relative > 30000 || relative < -30000
      || (block.kind === 'video' && block.key && ms !== state.clusterMs)
      || (!state.hasVideo && relative >= 5000);
    if (newCluster) {
      state.clusterMs = ms;
      state.out.push(concat([idBytes(0x1F43B675), UNKNOWN_SIZE]), uint(0xE7, ms));
    }
    const header = new Uint8Array(4);
    header[0] = 0x80 | block.track;
    new DataView(header.buffer).setInt16(1, ms - state.clusterMs);
    header[3] = block.key ? 0x80 : 0;
    state.out.push(element(0xA3, concat([header, block.data])));
  }

  function headerReady(state, force) {
    if (state.headerWritten)
      return true;
    const ready = state.tracks.every((track) => track.ready);
    const span = state.pending.length ? state.pending[state.pending.length - 1].timestamp - state.pending[0].timestamp : 0;
    if (!ready && !force && span < 1e6)
      return false;
    // Spuren ohne ein einziges Bild fallen weg (z.B. Canvas, das nie gemalt hat)
    if (!ready) {
      state.tracks = state.tracks.filter((track) => track.ready);
      state.tracks.forEach((track, index) => {
        track.number = index + 1;
      });
    }
    if (!state.tracks.length)
      return false;
    writeHeader(state);
    return true;
  }

  function pushBlock(state, block) {
    state.pending.push(block);
    if (!headerReady(state, false))
      return;
    for (const pending of state.pending.splice(0)) {
      const track = state.tracks.find((t) => t.kind === pending.kind);
      if (!track)
        continue;
      pending.track = track.number;
      writeBlock(state, pending);
    }
  }

  // ---------------------------------------------------------------- Encoder
  const recorders = new Map();

  function chunkBytes(chunk) {
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    return data;
  }

  function create(id, configText) {
    try {
      const config = JSON.parse(configText);
      const state = { id, config, tracks: [], pending: [], out: [], headerWritten: false, clusterMs: null, firstMs: null,
        video: null, audio: null, hasVideo: !!config.video, closed: false, error: null };
      if (config.video) {
        const codec = VIDEO_CODECS[config.video.codec];
        if (!codec || typeof VideoEncoder !== 'function')
          return stringToNewUTF8('Video codec is not supported');
        state.tracks.push({ kind: 'video', codecId: codec.id, number: state.tracks.length + 1, ready: false });
        state.video = { codec: codec.codec, bitrate: config.video.bitrate, encoder: null, width: 0, height: 0, lastKey: -Infinity };
      }
      if (config.audio) {
        if (typeof AudioEncoder !== 'function')
          return stringToNewUTF8('Audio codec is not supported');
        state.tracks.push({ kind: 'audio', codecId: 'A_OPUS', number: state.tracks.length + 1, ready: false });
        state.audio = { bitrate: config.audio.bitrate, encoder: null, sampleRate: 0, channels: 0 };
      }
      recorders.set(id, state);
      return 0;
    } catch (e) {
      return stringToNewUTF8(String(e && e.message || e));
    }
  }

  function fail(state, error) {
    if (!state.error)
      state.error = String(error && error.message || error);
    console.log('[recorder] ' + state.error);
  }

  function videoEncoder(state, width, height) {
    const video = state.video;
    if (video.encoder && video.width === width && video.height === height)
      return video.encoder;
    const track = state.tracks.find((t) => t.kind === 'video');
    if (!video.encoder) {
      video.encoder = new VideoEncoder({
        output: (chunk, metadata) => {
          if (state.closed)
            return;
          if (!track.ready) {
            const description = metadata && metadata.decoderConfig && metadata.decoderConfig.description;
            if (description)
              track.description = new Uint8Array(ArrayBuffer.isView(description) ? description.buffer.slice(description.byteOffset, description.byteOffset + description.byteLength) : description.slice(0));
            track.ready = true;
          }
          pushBlock(state, { kind: 'video', timestamp: chunk.timestamp, key: chunk.type === 'key', data: chunkBytes(chunk) });
        },
        error: (e) => fail(state, e),
      });
    }
    if (!track.width) {
      track.width = width;
      track.height = height;
    }
    video.width = width;
    video.height = height;
    video.lastKey = -Infinity;
    video.encoder.configure({ codec: video.codec, width, height, bitrate: video.bitrate, framerate: 30, latencyMode: 'realtime' });
    return video.encoder;
  }

  function video(id, ptr, size, format, width, height, timestamp) {
    const state = recorders.get(id);
    if (!state || !state.video || state.closed || state.error)
      return;
    let frame = null;
    try {
      const encoder = videoEncoder(state, width, height);
      // Zu viel in der Warteschlange: Bild auslassen (wie Chrome bei Last)
      if (encoder.encodeQueueSize > 8)
        return;
      const init = { format: VIDEO_FORMATS[format], codedWidth: width, codedHeight: height, timestamp };
      frame = new VideoFrame(HEAPU8.slice(ptr, ptr + size), init);
      const key = timestamp - state.video.lastKey >= KEYFRAME_INTERVAL;
      if (key)
        state.video.lastKey = timestamp;
      encoder.encode(frame, { keyFrame: key });
    } catch (e) {
      fail(state, e);
    } finally {
      if (frame)
        frame.close();
    }
  }

  function audio(id, ptr, frames, channels, sampleRate, timestamp) {
    const state = recorders.get(id);
    if (!state || !state.audio || state.closed || state.error)
      return;
    const audio = state.audio;
    let data = null;
    try {
      if (!audio.encoder || audio.sampleRate !== sampleRate || audio.channels !== channels) {
        const track = state.tracks.find((t) => t.kind === 'audio');
        if (!audio.encoder) {
          audio.encoder = new AudioEncoder({
            output: (chunk, metadata) => {
              if (state.closed)
                return;
              if (!track.ready) {
                const description = metadata && metadata.decoderConfig && metadata.decoderConfig.description;
                if (description)
                  track.description = new Uint8Array(ArrayBuffer.isView(description) ? description.buffer.slice(description.byteOffset, description.byteOffset + description.byteLength) : description.slice(0));
                track.ready = true;
              }
              pushBlock(state, { kind: 'audio', timestamp: chunk.timestamp, key: true, data: chunkBytes(chunk) });
            },
            error: (e) => fail(state, e),
          });
        }
        track.channels = channels;
        track.sampleRate = sampleRate;
        audio.sampleRate = sampleRate;
        audio.channels = channels;
        audio.encoder.configure({ codec: 'opus', sampleRate, numberOfChannels: channels, bitrate: audio.bitrate });
      }
      data = new AudioData({ format: 'f32-planar', sampleRate, numberOfFrames: frames, numberOfChannels: channels, timestamp,
        data: HEAPU8.slice(ptr, ptr + frames * channels * 4) });
      audio.encoder.encode(data);
    } catch (e) {
      fail(state, e);
    } finally {
      if (data)
        data.close();
    }
  }

  // Fertige Bytes seit dem letzten Aufruf; Laenge nach lengthPtr, 0 = nichts
  function take(id, lengthPtr) {
    const state = recorders.get(id);
    HEAP32[lengthPtr >> 2] = 0;
    if (!state || !state.out.length)
      return 0;
    const bytes = concat(state.out.splice(0));
    const ptr = Module._malloc(Math.max(bytes.length, 1));
    HEAPU8.set(bytes, ptr);
    HEAP32[lengthPtr >> 2] = bytes.length;
    return ptr;
  }

  // Alles kodieren, was noch in den Encodern steckt, dann bl_recorder_flushed
  function flush(id) {
    const state = recorders.get(id);
    const encoders = state ? [state.video && state.video.encoder, state.audio && state.audio.encoder].filter(Boolean) : [];
    Promise.all(encoders.map((encoder) => encoder.state === 'configured' ? encoder.flush().catch(() => {}) : null)).then(() => {
      if (state && !state.closed && headerReady(state, true)) {
        for (const pending of state.pending.splice(0)) {
          const track = state.tracks.find((t) => t.kind === pending.kind);
          if (track) {
            pending.track = track.number;
            writeBlock(state, pending);
          }
        }
      }
      Module._bl_recorder_flushed(id);
    });
  }

  function close(id) {
    const state = recorders.get(id);
    if (!state)
      return;
    state.closed = true;
    recorders.delete(id);
    for (const encoder of [state.video && state.video.encoder, state.audio && state.audio.encoder]) {
      try {
        if (encoder && encoder.state !== 'closed')
          encoder.close();
      } catch (e) {
      }
    }
  }

  return { create, video, audio, take, flush, close };
})();
