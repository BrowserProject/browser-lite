// WebCodecs der Seiten (engine/src/media/WebCodecsWasm.cpp), Host-Seite.
//
// Laeuft im Engine-Worker (--pre-js), aufgerufen nur im Engine-Thread. Jeder
// Codec der Seite bekommt hier einen echten Codec des Host-Browsers.
// Dekodierte Bilder und Ton kopieren wir in den Speicher der Engine und
// melden sie ueber Module._bl_codec_* zurueck. Fehler, die sofort feststehen,
// gehen als Text zurueck (Zeiger, die Engine gibt ihn frei), 0 = ok.
var blCodecs = (function () {
  'use strict';
  // Reihenfolge wie die Enums von WebCore (VideoPixelFormat, AudioSampleFormat, Farbraum-IDL)
  const VIDEO_FORMATS = ['I420', 'I420A', 'I422', 'I444', 'NV12', 'RGBA', 'RGBX', 'BGRA', 'BGRX'];
  const AUDIO_FORMATS = ['u8', 's16', 's32', 'f32', 'u8-planar', 's16-planar', 's32-planar', 'f32-planar'];
  const PRIMARIES = ['bt709', 'bt470bg', 'smpte170m', 'bt470m', 'smpte240m', 'film', 'bt2020', 'smpteSt4281', 'smpteRp431', 'smpte432', 'jedecP22Phosphors'];
  const TRANSFER = ['bt709', 'smpte170m', 'iec61966-2-1', 'gamma22curve', 'gamma28curve', 'smpte240m', 'linear', 'log', 'logSqrt', 'iec6196624', 'bt1361ExtendedColourGamut', 'bt2020_10bit', 'bt2020_12bit', 'pq', 'smpteSt4281', 'hlg'];
  const MATRIX = ['rgb', 'bt709', 'bt470bg', 'smpte170m', 'smpte240m', 'fcc', 'yCgCo', 'bt2020-ncl', 'bt2020-cl'];
  const KIND = ['VideoDecoder', 'VideoEncoder', 'AudioDecoder', 'AudioEncoder'];

  const codecs = new Map();

  function text(value) {
    return stringToNewUTF8(String(value));
  }
  function errorText(error) {
    return text(error && error.message ? error.message : error);
  }

  function packColorSpace(space) {
    const index = (list, value) => {
      const i = value ? list.indexOf(value) : -1;
      return i < 0 ? 255 : i;
    };
    if (!space)
      return (255 | 255 << 8 | 255 << 16 | 2 << 24) >>> 0;
    const full = space.fullRange === true ? 1 : space.fullRange === false ? 0 : 2;
    return (index(PRIMARIES, space.primaries) | index(TRANSFER, space.transfer) << 8 | index(MATRIX, space.matrix) << 16 | full << 24) >>> 0;
  }
  function unpackColorSpace(packed) {
    const space = {};
    const primaries = packed & 255, transfer = (packed >>> 8) & 255, matrix = (packed >>> 16) & 255, full = (packed >>> 24) & 255;
    if (primaries < PRIMARIES.length) space.primaries = PRIMARIES[primaries];
    if (transfer < TRANSFER.length) space.transfer = TRANSFER[transfer];
    if (matrix < MATRIX.length) space.matrix = MATRIX[matrix];
    if (full < 2) space.fullRange = full === 1;
    return space;
  }

  // Ebenen dicht hintereinander, wie VideoFrameWasm::planes
  function videoLayout(format, width, height) {
    const cw = (width + 1) >> 1, ch = (height + 1) >> 1;
    let planes;
    switch (format) {
    case 'I420': planes = [[width, height], [cw, ch], [cw, ch]]; break;
    case 'I420A': planes = [[width, height], [cw, ch], [cw, ch], [width, height]]; break;
    case 'I422': planes = [[width, height], [cw, height], [cw, height]]; break;
    case 'I444': planes = [[width, height], [width, height], [width, height]]; break;
    case 'NV12': planes = [[width, height], [cw * 2, ch]]; break;
    default: planes = [[width * 4, height]];
    }
    const layout = [];
    let offset = 0;
    for (const [stride, rows] of planes) {
      layout.push({ offset, stride });
      offset += stride * rows;
    }
    return { layout, size: offset };
  }

  function heapView(ptr, size) {
    return new Uint8Array(HEAPU8.buffer, ptr, size);
  }

  // Bild ohne bekanntes Format (z.B. von der GPU): ueber ein Canvas als RGBA
  let canvas = null;
  function readViaCanvas(frame, rect, ptr) {
    if (!canvas)
      canvas = new OffscreenCanvas(rect.width, rect.height);
    canvas.width = rect.width;
    canvas.height = rect.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(frame, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
    const pixels = context.getImageData(0, 0, rect.width, rect.height).data;
    HEAPU8.set(pixels, ptr);
  }

  async function deliverVideoFrame(id, state, generation, frame) {
    let ptr = 0;
    try {
      if (state.closed || generation !== state.generation)
        return;
      const visible = frame.visibleRect;
      const rect = { x: visible.x, y: visible.y, width: visible.width, height: visible.height };
      let format = VIDEO_FORMATS.indexOf(frame.format) >= 0 ? frame.format : 'RGBA';
      const { layout, size } = videoLayout(format, rect.width, rect.height);
      ptr = Module._malloc(size);
      if (frame.format === format) {
        try {
          await frame.copyTo(heapView(ptr, size), { rect, layout });
        } catch (e) {
          // SharedArrayBuffer nicht erlaubt: ueber einen eigenen Puffer
          const copy = new Uint8Array(size);
          await frame.copyTo(copy, { rect, layout });
          HEAPU8.set(copy, ptr);
        }
      } else
        readViaCanvas(frame, rect, ptr);
      if (state.closed || generation !== state.generation)
        return;
      const result = ptr;
      ptr = 0;
      Module._bl_codec_video_frame(id, result, size, VIDEO_FORMATS.indexOf(format), rect.width, rect.height,
        frame.timestamp, frame.duration == null ? -1 : frame.duration, packColorSpace(frame.colorSpace));
    } catch (e) {
      if (!state.closed)
        Module._bl_codec_error(id, errorText(e));
    } finally {
      if (ptr)
        Module._free(ptr);
      frame.close();
    }
  }

  async function deliverAudioData(id, state, generation, data) {
    let ptr = 0;
    try {
      if (state.closed || generation !== state.generation)
        return;
      const format = data.format;
      const index = AUDIO_FORMATS.indexOf(format);
      if (index < 0)
        throw new Error('Unbekanntes Tonformat ' + format);
      const planar = format.endsWith('-planar');
      const planes = planar ? data.numberOfChannels : 1;
      const sizes = [];
      let size = 0;
      for (let plane = 0; plane < planes; plane++) {
        const bytes = data.allocationSize({ planeIndex: plane });
        sizes.push(bytes);
        size += bytes;
      }
      ptr = Module._malloc(Math.max(size, 1));
      let offset = 0;
      for (let plane = 0; plane < planes; plane++) {
        const copy = new Uint8Array(sizes[plane]);
        data.copyTo(copy, { planeIndex: plane });
        HEAPU8.set(copy, ptr + offset);
        offset += sizes[plane];
      }
      const result = ptr;
      ptr = 0;
      Module._bl_codec_audio_data(id, result, size, index, data.sampleRate, data.numberOfFrames, data.numberOfChannels, data.timestamp);
    } catch (e) {
      if (!state.closed)
        Module._bl_codec_error(id, errorText(e));
    } finally {
      if (ptr)
        Module._free(ptr);
      data.close();
    }
  }

  function bytesToHeap(bytes) {
    const ptr = Module._malloc(Math.max(bytes.byteLength, 1));
    HEAPU8.set(new Uint8Array(bytes.buffer || bytes, bytes.byteOffset || 0, bytes.byteLength), ptr);
    return ptr;
  }

  function sendEncoded(id, state, chunk, metadata) {
    if (state.closed)
      return;
    const decoderConfig = metadata && metadata.decoderConfig;
    if (decoderConfig) {
      let description = 0, length = -1;
      if (decoderConfig.description) {
        const bytes = ArrayBuffer.isView(decoderConfig.description) ? decoderConfig.description : new Uint8Array(decoderConfig.description);
        description = bytesToHeap(bytes);
        length = bytes.byteLength;
      }
      if (state.kind === 1)
        Module._bl_codec_video_config(id, text(decoderConfig.codec), description, length,
          decoderConfig.codedWidth || 0, decoderConfig.codedHeight || 0,
          packColorSpace(decoderConfig.colorSpace));
      else
        Module._bl_codec_audio_config(id, text(decoderConfig.codec), description, length, decoderConfig.sampleRate || 0, decoderConfig.numberOfChannels || 0);
    }
    const ptr = Module._malloc(Math.max(chunk.byteLength, 1));
    const copy = new Uint8Array(chunk.byteLength);
    chunk.copyTo(copy);
    HEAPU8.set(copy, ptr);
    const temporal = metadata && metadata.svc && metadata.svc.temporalLayerId != null ? metadata.svc.temporalLayerId : -1;
    Module._bl_codec_encoded(id, ptr, chunk.byteLength, chunk.type === 'key' ? 1 : 0, chunk.timestamp, chunk.duration == null ? -1 : chunk.duration, temporal);
  }

  function create(id, kind, configText, description) {
    try {
      const type = KIND[kind];
      const Codec = self[type];
      if (typeof Codec !== 'function')
        return text(type + ' is not supported');
      const config = JSON.parse(configText);
      if (description)
        config.description = description;
      if (kind === 1) {
        const annexb = config.annexb;
        delete config.annexb;
        if (/^avc[13]\./.test(config.codec))
          config.avc = { format: annexb ? 'annexb' : 'avc' };
        else if (/^(hev1|hvc1)\./.test(config.codec))
          config.hevc = { format: annexb ? 'annexb' : 'hevc' };
      }
      const state = { kind, config, codec: null, chain: Promise.resolve(), generation: 0, closed: false };
      codecs.set(id, state);
      Codec.isConfigSupported(config).then((support) => {
        if (state.closed)
          return;
        if (!support.supported)
          throw new Error('Codec is not supported');
        const output = kind === 0 ? (frame) => {
          const generation = state.generation;
          state.chain = state.chain.then(() => deliverVideoFrame(id, state, generation, frame));
        } : kind === 2 ? (data) => {
          const generation = state.generation;
          state.chain = state.chain.then(() => deliverAudioData(id, state, generation, data));
        } : (chunk, metadata) => sendEncoded(id, state, chunk, metadata);
        state.codec = new Codec({
          output,
          error: (e) => {
            if (!state.closed)
              Module._bl_codec_error(id, errorText(e));
          },
        });
        state.codec.configure(config);
        Module._bl_codec_created(id, 0);
      }).catch((e) => {
        codecs.delete(id);
        if (!state.closed)
          Module._bl_codec_created(id, errorText(e));
      });
      return 0;
    } catch (e) {
      codecs.delete(id);
      return errorText(e);
    }
  }

  function decode(id, data, key, timestamp, duration) {
    const state = codecs.get(id);
    if (!state || !state.codec)
      return text('Decoder is closed');
    try {
      const init = { type: key ? 'key' : 'delta', timestamp, data };
      if (duration >= 0)
        init.duration = duration;
      state.codec.decode(state.kind === 0 ? new EncodedVideoChunk(init) : new EncodedAudioChunk(init));
      return 0;
    } catch (e) {
      return errorText(e);
    }
  }

  function encodeVideo(id, ptr, size, format, width, height, timestamp, duration, colorSpace, key) {
    const state = codecs.get(id);
    if (!state || !state.codec)
      return text('Encoder is closed');
    let frame = null;
    try {
      const init = { format: VIDEO_FORMATS[format], codedWidth: width, codedHeight: height, timestamp, colorSpace: unpackColorSpace(colorSpace) };
      if (duration >= 0)
        init.duration = duration;
      init.layout = videoLayout(init.format, width, height).layout;
      try {
        frame = new VideoFrame(heapView(ptr, size), init);
      } catch (e) {
        frame = new VideoFrame(HEAPU8.slice(ptr, ptr + size), init);
      }
      state.codec.encode(frame, { keyFrame: !!key });
      return 0;
    } catch (e) {
      return errorText(e);
    } finally {
      if (frame)
        frame.close();
    }
  }

  function encodeAudio(id, ptr, size, format, sampleRate, frames, channels, timestamp) {
    const state = codecs.get(id);
    if (!state || !state.codec)
      return text('Encoder is closed');
    let data = null;
    try {
      data = new AudioData({ format: AUDIO_FORMATS[format], sampleRate, numberOfFrames: frames, numberOfChannels: channels, timestamp, data: HEAPU8.slice(ptr, ptr + size) });
      state.codec.encode(data);
      return 0;
    } catch (e) {
      return errorText(e);
    } finally {
      if (data)
        data.close();
    }
  }

  function flush(id) {
    const state = codecs.get(id);
    if (!state || !state.codec) {
      Module._bl_codec_flushed(id, 1);
      return;
    }
    state.codec.flush().then(() => true, () => false).then((ok) => state.chain.then(() => ok)).then((ok) => {
      Module._bl_codec_flushed(id, ok ? 1 : 0);
    });
  }

  function reset(id) {
    const state = codecs.get(id);
    if (!state || !state.codec)
      return;
    state.generation++;
    try {
      state.codec.reset();
      state.codec.configure(state.config);
    } catch (e) {
    }
  }

  function close(id) {
    const state = codecs.get(id);
    if (!state)
      return;
    state.closed = true;
    codecs.delete(id);
    try {
      if (state.codec && state.codec.state !== 'closed')
        state.codec.close();
    } catch (e) {
    }
  }

  function setRates(id, bitrate, framerate) {
    const state = codecs.get(id);
    if (!state || !state.codec)
      return text('Encoder is closed');
    try {
      if (bitrate)
        state.config.bitrate = bitrate;
      if (framerate)
        state.config.framerate = framerate;
      state.codec.configure(state.config);
      return 0;
    } catch (e) {
      return errorText(e);
    }
  }

  return { create, decode, encodeVideo, encodeAudio, flush, reset, close, setRates };
})();
