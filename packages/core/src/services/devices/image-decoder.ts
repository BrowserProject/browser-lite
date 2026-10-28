import { base64ToBytes, bytesToBase64, domError } from '../../util.js';
import type { ServiceContext } from '../service.js';

interface ImageTrack {
  animated: boolean;
  frameCount: number;
  repetitionCount: number;
  selected: boolean;
}

interface HostImageDecoder {
  readonly tracks: ArrayLike<ImageTrack> & { ready: Promise<void> };
  readonly completed: Promise<void>;
  decode(options: { frameIndex: number }): Promise<{ image: VideoFrame }>;
  close(): void;
}

interface DecoderClass {
  new (init: { data: Uint8Array; type: string; preferAnimation?: boolean }): HostImageDecoder;
  isTypeSupported(type: string): Promise<boolean>;
}

interface Payload {
  id?: number;
  type?: string;
  data?: string;
  preferAnimation?: boolean;
  frameIndex?: number;
}

/** WebCodecs ImageDecoder of the pages (polyfill in engine WebPlatformExtras.cpp). */
export function installImageDecoder(ctx: ServiceContext): void {
  const decoders = new Map<number, { decoder: HostImageDecoder; origin: string; view: number }>();
  let next = 1;
  const Decoder = () => (globalThis as { ImageDecoder?: DecoderClass }).ImageDecoder;

  const decoderFor = (payload: Payload | null, origin: string) => {
    const entry = payload?.id === undefined ? undefined : decoders.get(payload.id);
    if (!entry || entry.origin !== origin)
      throw domError('InvalidStateError', 'The decoder has been closed.');
    return entry.decoder;
  };

  ctx.hostCall<Payload | null>('image-supported', async (payload) => {
    const decoder = Decoder();
    return !!decoder && (await decoder.isTypeSupported(String(payload?.type)));
  });
  ctx.hostCall<Payload | null>('image-open', async (payload, origin, view) => {
    const Class = Decoder();
    if (!Class) throw domError('NotSupportedError', 'ImageDecoder is not available');
    const init: { data: Uint8Array; type: string; preferAnimation?: boolean } = {
      data: base64ToBytes(payload?.data || ''),
      type: String(payload?.type),
    };
    if (typeof payload?.preferAnimation === 'boolean')
      init.preferAnimation = payload.preferAnimation;
    const decoder = new Class(init);
    await decoder.tracks.ready;
    await decoder.completed;
    const id = next++;
    decoders.set(id, { decoder, origin, view: view?.id ?? 0 });
    const tracks = [];
    for (let i = 0; i < decoder.tracks.length; i++) {
      const track = decoder.tracks[i] as ImageTrack;
      tracks.push({
        animated: track.animated,
        frameCount: track.frameCount,
        repetitionCount: track.repetitionCount,
        selected: track.selected,
      });
    }
    return { id, tracks };
  });
  ctx.hostCall<Payload | null>('image-decode', async (payload, origin) => {
    const { image } = await decoderFor(payload, origin).decode({
      frameIndex: Number(payload?.frameIndex) || 0,
    });
    try {
      const width = image.displayWidth;
      const height = image.displayHeight;
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw domError('EncodingError', 'No 2d context');
      context.drawImage(image, 0, 0, width, height);
      const pixels = new Uint8Array(context.getImageData(0, 0, width, height).data.buffer);
      // WebKit gives a still image the timestamp -2^63, which the engine's VideoFrame refuses;
      // Chrome gives 0
      return {
        width,
        height,
        timestamp: Number.isSafeInteger(image.timestamp) ? image.timestamp : 0,
        duration: Number.isSafeInteger(image.duration) ? image.duration : null,
        data: bytesToBase64(pixels),
      };
    } finally {
      image.close();
    }
  });
  ctx.hostCall<Payload | null>('image-close', async (payload, origin) => {
    decoderFor(payload, origin).close();
    if (payload?.id !== undefined) decoders.delete(payload.id);
    return {};
  });
  ctx.onView((view, signal) =>
    signal.addEventListener('abort', () => {
      for (const [id, entry] of decoders) {
        if (entry.view === view.id) {
          decoders.delete(id);
          entry.decoder.close();
        }
      }
    }),
  );
  ctx.signal.addEventListener('abort', () => {
    for (const entry of decoders.values()) entry.decoder.close();
    decoders.clear();
  });
}
