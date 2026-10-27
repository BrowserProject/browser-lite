import { Service, type ServiceContext } from './service.js';
import { streamTrackToEngine } from './track-source.js';

interface CaptureRequest {
  id: number;
  kind: 'camera' | 'microphone' | 'screen';
  width?: number;
  height?: number;
  frameRate?: number;
  echoCancellation?: boolean;
}

interface Entry {
  stream: MediaStream | null;
  track: MediaStreamTrack | null;
  stopHost: () => void;
  ready: Promise<MediaStreamTrack | null>;
  resolve(track: MediaStreamTrack | null): void;
}

/** Shared with media (picture-in-picture) and webrtc: the host track of an engine capture. */
export interface CaptureApi {
  track(id: number): Promise<MediaStreamTrack | null>;
}

const constraint = (value: number | undefined) => (value ? { ideal: value } : undefined);

function openHostDevice(data: CaptureRequest): Promise<MediaStream> {
  if (data.kind === 'screen')
    return navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: constraint(data.frameRate) },
      audio: false,
    });
  if (data.kind === 'camera')
    return navigator.mediaDevices.getUserMedia({
      video: {
        width: constraint(data.width),
        height: constraint(data.height),
        frameRate: constraint(data.frameRate),
      },
    });
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: data.echoCancellation !== false },
  });
}

/**
 * Camera, microphone and screen for the pages (engine MediaStreamWasm.cpp). The engine asked
 * for permission already; here the host device opens and its frames go straight to the engine
 * worker (track-source.ts, engine/js/webcodecs-host.js).
 */
export class CaptureService extends Service {
  readonly features = ['capture'] as const;

  constructor() {
    super('capture');
  }

  setup(ctx: ServiceContext): void {
    const captures = new Map<number, Entry>();

    const stop = (data: { id: number }) => {
      const entry = captures.get(data.id);
      if (!entry) return;
      captures.delete(data.id);
      entry.stopHost();
      for (const track of entry.stream?.getTracks() ?? []) track.stop();
      ctx.engineWorker()?.postMessage({ blCapture: { id: data.id } });
    };

    const start = async (data: CaptureRequest) => {
      stop(data);
      let resolve: (track: MediaStreamTrack | null) => void = () => {};
      const ready = new Promise<MediaStreamTrack | null>((done) => {
        resolve = done;
      });
      const entry: Entry = { stream: null, track: null, stopHost: () => {}, ready, resolve };
      captures.set(data.id, entry);
      try {
        if (!navigator.mediaDevices) throw new Error('No media devices');
        const stream = await openHostDevice(data);
        if (captures.get(data.id) !== entry || ctx.signal.aborted) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }
        const track =
          data.kind === 'microphone' ? stream.getAudioTracks()[0] : stream.getVideoTracks()[0];
        if (!track) throw new Error('No track');
        entry.stream = stream;
        entry.track = track;
        entry.resolve(track);
        // For example "Stop sharing" of the host browser
        track.addEventListener('ended', () => {
          if (captures.get(data.id) !== entry) return;
          captures.delete(data.id);
          entry.stopHost();
          ctx.module._bl_capture_ended(data.id);
        });
        const stopHost = await streamTrackToEngine(ctx, data.id, track);
        if (captures.get(data.id) !== entry) stopHost();
        else entry.stopHost = stopHost;
      } catch (error) {
        if (captures.get(data.id) === entry) captures.delete(data.id);
        console.warn('[browser-lite] capture', data.kind, (error as Error)?.message ?? error);
        entry.resolve(null);
        if (!ctx.signal.aborted) ctx.module._bl_capture_failed(data.id);
      }
    };

    ctx.on<CaptureRequest>('capture-start', (data) => {
      start(data);
    });
    ctx.on<{ id: number }>('capture-stop', stop);
    ctx.provide('capture', {
      async track(id: number) {
        const entry = captures.get(id);
        return entry ? (entry.track ?? (await entry.ready)) : null;
      },
    } satisfies CaptureApi);
    ctx.signal.addEventListener('abort', () => {
      for (const entry of captures.values()) {
        entry.stopHost();
        for (const track of entry.stream?.getTracks() ?? []) track.stop();
      }
      captures.clear();
    });
  }
}
