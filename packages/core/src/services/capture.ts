import { Service, type ServiceContext } from './service.js';
import { streamTrackToEngine } from './track-source.js';

interface CaptureRequest {
  id: number;
  kind: 'camera' | 'microphone' | 'screen';
  /** Index among the host's cameras or microphones (hostCaptureDevices). */
  device?: number;
  width?: number;
  height?: number;
  frameRate?: number;
  echoCancellation?: boolean;
}

interface Entry {
  stream: MediaStream | null;
  track: MediaStreamTrack | null;
  streaming: boolean;
  stopHost: () => void;
  ready: Promise<MediaStreamTrack | null>;
  resolve(track: MediaStreamTrack | null): void;
}

/** Shared with media (picture-in-picture) and webrtc: the host track of an engine capture. */
export interface CaptureApi {
  track(id: number): Promise<MediaStreamTrack | null>;
}

/** Device ids of the host's cameras and microphones, empty strings before its permission. */
export interface HostCaptureDevices {
  cameras: string[];
  microphones: string[];
}

/**
 * The cameras and microphones of the host's enumerateDevices. Chrome adds a 'default' and (on
 * Windows) a 'communications' entry that repeat a real microphone; they do not count.
 */
export function hostCaptureDevices(devices: readonly MediaDeviceInfo[]): HostCaptureDevices {
  const ids = (kind: MediaDeviceKind) =>
    devices
      .filter(
        (device) =>
          device.kind === kind &&
          device.deviceId !== 'default' &&
          device.deviceId !== 'communications',
      )
      .map((device) => device.deviceId);
  return { cameras: ids('videoinput'), microphones: ids('audioinput') };
}

/** Error of bl_capture_opened for a failed host getUserMedia or getDisplayMedia. */
export function openError(error: unknown): number {
  const name = (error as { name?: string } | null)?.name;
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 1;
  if (name === 'NotAllowedError' || name === 'SecurityError') return 2;
  return 3;
}

const constraint = (value: number | undefined) => (value ? { ideal: value } : undefined);
const exactDevice = (id: string | undefined) => (id ? { exact: id } : undefined);

function openHostDevice(data: CaptureRequest, deviceId: string | undefined): Promise<MediaStream> {
  if (!navigator.mediaDevices) return Promise.reject(new Error('No media devices'));
  if (data.kind === 'screen')
    return navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: constraint(data.frameRate) },
      audio: false,
    });
  if (data.kind === 'camera')
    return navigator.mediaDevices.getUserMedia({
      video: {
        deviceId: exactDevice(deviceId),
        width: constraint(data.width),
        height: constraint(data.height),
        frameRate: constraint(data.frameRate),
      },
    });
  return navigator.mediaDevices.getUserMedia({
    audio: { deviceId: exactDevice(deviceId), echoCancellation: data.echoCancellation !== false },
  });
}

/**
 * Camera, microphone and screen for the pages (engine MediaStreamWasm.cpp). The engine knows how
 * many cameras and microphones the host has (no ids or names), and asked for permission already
 * when it opens one: the host device opens before the page's getUserMedia resolves, so a device
 * that does not open rejects it; its frames go straight to the engine worker (track-source.ts,
 * engine/js/webcodecs-host.js).
 */
export class CaptureService extends Service {
  readonly features = ['capture'] as const;

  /** Per browser: reports the host's devices to the engine (from start() on). */
  private readonly reporters = new WeakMap<ServiceContext, () => void>();

  constructor() {
    super('capture');
  }

  override start(ctx: ServiceContext): void {
    const report = this.reporters.get(ctx);
    if (!report) return;
    navigator.mediaDevices?.addEventListener('devicechange', report, { signal: ctx.signal });
    report();
  }

  setup(ctx: ServiceContext): void {
    const captures = new Map<number, Entry>();
    let devices: HostCaptureDevices = { cameras: [], microphones: [] };
    let reports = 0;

    // From start(), on devicechange and after a device opened (the host names its devices only
    // after its permission, and then lists all of them)
    const reportDevices = async () => {
      const report = ++reports;
      let list: MediaDeviceInfo[] = [];
      try {
        list = (await navigator.mediaDevices?.enumerateDevices()) ?? [];
      } catch {}
      if (report !== reports || ctx.signal.aborted) return;
      devices = hostCaptureDevices(list);
      ctx.module._bl_set_capture_devices(devices.cameras.length, devices.microphones.length);
    };
    this.reporters.set(ctx, reportDevices);

    const stop = (data: { id: number }) => {
      const entry = captures.get(data.id);
      if (!entry) return;
      captures.delete(data.id);
      entry.stopHost();
      for (const track of entry.stream?.getTracks() ?? []) track.stop();
      ctx.engineWorker()?.postMessage({ blCapture: { id: data.id } });
    };

    // A new entry with the host device opened: 0 or the error of bl_capture_opened
    const open = async (data: CaptureRequest): Promise<{ entry: Entry; error: number }> => {
      stop(data);
      let resolve: (track: MediaStreamTrack | null) => void = () => {};
      const ready = new Promise<MediaStreamTrack | null>((done) => {
        resolve = done;
      });
      const entry: Entry = {
        stream: null,
        track: null,
        streaming: false,
        stopHost: () => {},
        ready,
        resolve,
      };
      captures.set(data.id, entry);
      const ids = data.kind === 'camera' ? devices.cameras : devices.microphones;
      try {
        const stream = await openHostDevice(data, ids[data.device ?? 0]);
        if (captures.get(data.id) !== entry || ctx.signal.aborted) {
          for (const track of stream.getTracks()) track.stop();
          return { entry, error: 3 };
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
        if (data.kind !== 'screen') reportDevices();
        return { entry, error: 0 };
      } catch (error) {
        if (captures.get(data.id) === entry) captures.delete(data.id);
        console.warn('[browser-lite] capture', data.kind, (error as Error)?.message ?? error);
        entry.resolve(null);
        return { entry, error: openError(error) };
      }
    };

    const stream = async (data: CaptureRequest, entry: Entry) => {
      if (entry.streaming || !entry.track) return;
      entry.streaming = true;
      try {
        const stopHost = await streamTrackToEngine(ctx, data.id, entry.track);
        if (captures.get(data.id) !== entry) stopHost();
        else entry.stopHost = stopHost;
      } catch (error) {
        console.warn('[browser-lite] capture', data.kind, (error as Error)?.message ?? error);
        if (captures.get(data.id) !== entry) return;
        stop(data);
        if (!ctx.signal.aborted) ctx.module._bl_capture_failed(data.id);
      }
    };

    ctx.on<CaptureRequest>('capture-open', async (data) => {
      const { error } = await open(data);
      if (!ctx.signal.aborted) ctx.module._bl_capture_opened(data.id, error);
    });
    ctx.on<CaptureRequest>('capture-start', async (data) => {
      const opened = captures.get(data.id);
      if (opened?.track) return stream(data, opened);
      const { entry, error } = await open(data);
      if (!error) stream(data, entry);
      else if (!ctx.signal.aborted) ctx.module._bl_capture_failed(data.id);
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
