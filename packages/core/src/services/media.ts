import { installPictureInPicture } from './pip.js';
import { Service, type ServiceContext } from './service.js';

const STATE_EVENTS = [
  'loadedmetadata',
  'durationchange',
  'loadeddata',
  'canplay',
  'canplaythrough',
  'playing',
  'play',
  'pause',
  'waiting',
  'seeking',
  'ended',
  'progress',
  'resize',
  'stalled',
  'emptied',
  'ratechange',
  'suspend',
  'timeupdate',
];

interface PlayerOptions {
  hidden?: boolean;
  preload?: string;
  muted?: boolean;
  volume?: number;
  rate?: number;
  mse?: boolean;
}

type Operation = (() => void) & { retry?: boolean };

/** Media of the browser instance: hidden <video> elements of the host, one per engine player. */
export interface MediaHost {
  readonly ctx: ServiceContext;
  readonly container: HTMLElement;
  readonly players: Map<number, Player>;
  mediaUrl(player: number): string;
}

/**
 * One engine media player: a hidden <video> of the host plays it. Its bytes come through the
 * service worker from the engine (or MSE commands), frames are copied into WASM memory where
 * the engine paints them into the page. The sound comes straight from this <video>.
 */
export class Player {
  readonly video: HTMLVideoElement;
  frames = 0;
  pipHooked = false;
  private presentation = { width: 0, height: 0 };
  private frameInFlight = false;
  private lastTime = -1;
  private forceFrame = true;
  private hidden: boolean;
  private raf = 0;
  private canvas: OffscreenCanvas | null = null;
  private context2d: OffscreenCanvasRenderingContext2D | null = null;
  private readonly mediaSource: MediaSource | null = null;
  private readonly sourceBuffers = new Map<number, SourceBuffer>();
  private readonly queue: Operation[] = [];

  constructor(
    private readonly host: MediaHost,
    readonly id: number,
    options: PlayerOptions,
  ) {
    this.hidden = !!options.hidden;
    const video = document.createElement('video');
    this.video = video;
    video.playsInline = true;
    video.preload = (options.preload || 'auto') as HTMLVideoElement['preload'];
    video.muted = !!options.muted;
    video.volume = Math.min(1, Math.max(0, options.volume ?? 1));
    video.playbackRate = options.rate || 1;
    for (const type of STATE_EVENTS) video.addEventListener(type, () => this.sendState(type));
    video.addEventListener('seeked', () => {
      this.forceFrame = true;
      this.sendState('seeked');
    });
    video.addEventListener('loadeddata', () => {
      this.forceFrame = true;
    });
    video.addEventListener('error', () => {
      this.send({ type: 'error', code: video.error?.code || 4 });
    });
    host.container.append(video);
    if (options.mse) {
      // MSE: own MediaSource, the engine sends the data (SourceBufferPrivateWasm)
      this.mediaSource = new MediaSource();
      this.mediaSource.addEventListener('sourceopen', () => this.runQueue(), { once: true });
      video.src = URL.createObjectURL(this.mediaSource);
    } else {
      video.src = host.mediaUrl(id);
    }
    this.raf = requestAnimationFrame(() => this.pump());
  }

  private send(object: Record<string, unknown>): void {
    const { ctx } = this.host;
    if (!ctx.signal.aborted) ctx.module._bl_media_event(this.id, ctx.text(JSON.stringify(object)));
  }

  private sendState(type: string): void {
    const video = this.video;
    const buffered: number[] = [];
    for (let i = 0; i < video.buffered.length; i++)
      buffered.push(video.buffered.start(i), video.buffered.end(i));
    const duration = video.duration;
    this.send({
      type,
      time: video.currentTime,
      // JSON has no NaN/Infinity: -1 = infinite (live), missing = unknown
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

  // MSE: one operation after the other, each only when no SourceBuffer is updating

  private enqueue(operation: Operation): void {
    this.queue.push(operation);
    this.runQueue();
  }

  private busy(): boolean {
    for (const buffer of this.sourceBuffers.values()) if (buffer.updating) return true;
    return false;
  }

  private runQueue(): void {
    const source = this.mediaSource;
    if (!source) return;
    while (this.queue.length && source.readyState !== 'closed' && !this.busy()) {
      const operation = this.queue.shift() as Operation;
      try {
        operation();
      } catch (error) {
        if ((error as Error).name === 'QuotaExceededError' && operation.retry) {
          // Full: drop what lies far behind the current time, then try again
          operation.retry = false;
          this.queue.unshift(operation);
          const end = Math.max(0, this.video.currentTime - 10);
          for (const buffer of this.sourceBuffers.values())
            if (end > 0 && !buffer.updating) buffer.remove(0, end);
          if (end <= 0) this.queue.shift();
          return;
        }
        console.warn('[browser-lite] MSE in the host:', error);
      }
    }
  }

  private mseCommand(
    type: string,
    data: Record<string, unknown>,
    bytes: Uint8Array<ArrayBuffer> | null,
  ): boolean {
    const source = this.mediaSource as MediaSource;
    const fromTime = (value: unknown) => (value === -1 ? Infinity : (value as number));
    const buffer = () => this.sourceBuffers.get(data.sb as number);
    switch (type) {
      case 'sb-add':
        this.enqueue(() => {
          const added = source.addSourceBuffer(data.type as string);
          added.addEventListener('updateend', () => this.runQueue());
          added.addEventListener('error', () => console.warn('[browser-lite] SourceBuffer error'));
          this.sourceBuffers.set(data.sb as number, added);
        });
        return true;
      case 'sb-append': {
        const operation: Operation = () => {
          const target = buffer();
          if (!target || !bytes) return;
          if (target.timestampOffset !== data.offset)
            target.timestampOffset = data.offset as number;
          const windowEnd = fromTime(data.windowEnd);
          if (
            target.appendWindowStart !== data.windowStart ||
            target.appendWindowEnd !== windowEnd
          ) {
            target.appendWindowStart = 0;
            target.appendWindowEnd = windowEnd;
            target.appendWindowStart = data.windowStart as number;
          }
          target.appendBuffer(bytes);
        };
        operation.retry = true;
        this.enqueue(operation);
        return true;
      }
      case 'sb-abort':
        this.enqueue(() => {
          const target = buffer();
          if (target && source.readyState === 'open') target.abort();
        });
        return true;
      case 'sb-remove':
        this.enqueue(() => {
          const target = buffer();
          // In "ended" remove() sets the MediaSource back to "open" by itself
          if (!target || source.readyState === 'closed' || Number.isNaN(source.duration)) return;
          // Like WebCore: not beyond the duration
          const start = Math.min(data.start as number, source.duration);
          const end = fromTime(data.end);
          if (end > start) target.remove(start, end);
        });
        return true;
      case 'sb-type':
        this.enqueue(() => buffer()?.changeType(data.type as string));
        return true;
      case 'sb-remove-buffer':
        this.enqueue(() => {
          const target = buffer();
          this.sourceBuffers.delete(data.sb as number);
          if (target) source.removeSourceBuffer(target);
        });
        return true;
      case 'ms-duration':
        this.enqueue(() => {
          if (source.readyState === 'open') source.duration = fromTime(data.duration);
        });
        return true;
      case 'ms-eos':
        this.enqueue(() => {
          if (source.readyState === 'open')
            source.endOfStream((data.error as EndOfStreamError) || undefined);
        });
        return true;
    }
    return false;
  }

  command(
    type: string,
    data: Record<string, unknown>,
    bytes: Uint8Array<ArrayBuffer> | null,
  ): void {
    if (this.mediaSource && this.mseCommand(type, data, bytes)) return;
    const video = this.video;
    switch (type) {
      case 'play':
        video.play().catch(() => this.sendState('pause'));
        break;
      case 'pause':
        video.pause();
        break;
      case 'seek':
        video.currentTime = data.time as number;
        // Without data Chrome keeps the time but sends no seeked
        if (video.readyState === 0) this.send({ type: 'seeked', time: data.time });
        break;
      case 'rate':
        video.playbackRate = (data.rate as number) || 1;
        break;
      case 'volume':
        video.volume = Math.min(1, Math.max(0, data.volume as number));
        break;
      case 'muted':
        video.muted = !!data.muted;
        break;
      case 'pitch':
        video.preservesPitch = !!data.preservesPitch;
        break;
      case 'frame':
        this.frameInFlight = false;
        break;
      case 'visible':
        this.hidden = !data.visible;
        this.forceFrame = true;
        break;
      case 'preload':
        // A higher value applies by itself in Chrome; load() would start over
        video.preload = data.preload as HTMLVideoElement['preload'];
        break;
      case 'size':
        this.presentation = { width: data.width as number, height: data.height as number };
        this.forceFrame = true;
        break;
    }
  }

  // Frame size: as large as on screen, at most as large as the video
  private frameSize(): [number, number] {
    const video = this.video;
    let width = video.videoWidth;
    let height = video.videoHeight;
    const target = this.presentation.width * devicePixelRatio;
    if (target > 0 && target < width) {
      height = Math.max(1, Math.round((height * target) / width));
      width = Math.max(1, Math.round(target));
    }
    return [width, height];
  }

  private pump(): void {
    this.raf = requestAnimationFrame(() => this.pump());
    const video = this.video;
    if (this.hidden || video.readyState < 2 || !video.videoWidth || this.frameInFlight) return;
    if (video.currentTime === this.lastTime && !this.forceFrame) return;
    this.lastTime = video.currentTime;
    this.forceFrame = false;
    this.copyFrame();
  }

  // Every frame into its own buffer; the engine takes it over and frees it
  // (MediaPlayerPrivateWasm::hostFrame). We never touch it again.
  private copyFrame(): void {
    const { module } = this.host.ctx;
    const [width, height] = this.frameSize();
    if (!this.canvas || this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas = new OffscreenCanvas(width, height);
      this.context2d = this.canvas.getContext('2d', { alpha: false, willReadFrequently: true });
    }
    const context = this.context2d;
    if (!context) return;
    context.drawImage(this.video, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height).data;
    const ptr = module._malloc(pixels.length);
    if (!ptr) return;
    module.HEAPU8.set(pixels, ptr);
    this.frameInFlight = true;
    this.frames++;
    module._bl_media_frame(this.id, ptr, width, height);
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    const video = this.video;
    video.pause();
    if (this.mediaSource) URL.revokeObjectURL(video.src);
    video.removeAttribute('src');
    video.load();
    video.remove();
  }
}

interface FetchMessage {
  bl: string;
  instance: string;
  id: number;
  player: number;
  start: number;
  end: number;
}

async function serviceWorkerRegistration(
  ctx: ServiceContext,
): Promise<ServiceWorkerRegistration | null> {
  const option = ctx.config.serviceWorker;
  if (!option) {
    ctx.warn(
      'media-sw-missing',
      'No service worker given (serviceWorker option): <video> and <audio> files will not play',
    );
    return null;
  }
  if (!('serviceWorker' in navigator)) {
    ctx.warn('media-sw-missing', 'Service workers are not available: media files will not play');
    return null;
  }
  try {
    const registration =
      'registration' in option
        ? option.registration
        : await navigator.serviceWorker.register(
            option.url,
            option.scope ? { scope: option.scope } : {},
          );
    // On the first visit the worker controls the page only after clients.claim()
    if (!navigator.serviceWorker.controller)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 3000);
        navigator.serviceWorker.addEventListener(
          'controllerchange',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
    if (!navigator.serviceWorker.controller) {
      ctx.warn(
        'media-sw-missing',
        'The service worker does not control this page (scope or clients.claim): media files will not play',
      );
    }
    return registration;
  } catch (error) {
    ctx.warn('media-sw-missing', `Service worker failed: ${(error as Error)?.message ?? error}`);
    return null;
  }
}

/** <video> and <audio> of the pages (plus picture-in-picture). */
export class MediaService extends Service {
  readonly features: readonly string[];

  constructor(private readonly pictureInPicture: boolean) {
    super('media');
    this.features = pictureInPicture ? ['media', 'pip'] : ['media'];
  }

  async setup(ctx: ServiceContext): Promise<void> {
    const instance = crypto.randomUUID();
    const registration = await serviceWorkerRegistration(ctx);
    const scope = registration?.scope ?? new URL('./', location.href).href;
    const players = new Map<number, Player>();
    // Must be in the document, Chrome throttles detached videos
    const container = document.createElement('div');
    container.setAttribute('data-bl-media', '');
    container.style.cssText =
      'position:fixed;left:0;top:0;width:2px;height:2px;overflow:hidden;opacity:0.01;pointer-events:none;z-index:-1';
    document.body.append(container);
    const host: MediaHost = {
      ctx,
      container,
      players,
      mediaUrl: (player) =>
        new URL(`bl-media/${instance}/${player}/${Date.now().toString(36)}`, scope).href,
    };

    // Bytes for the service worker: one engine fetch per worker request
    const fetchSources = new Map<number, { source: MessageEventSource; id: number }>();
    let nextFetchId = 1;
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener(
        'message',
        (event) => {
          const message = event.data as FetchMessage | null;
          if (!message || message.instance !== instance || !event.source || ctx.signal.aborted)
            return;
          if (message.bl === 'media-fetch') {
            const fetchId = nextFetchId++;
            fetchSources.set(fetchId, { source: event.source, id: message.id });
            ctx.module._bl_media_fetch(message.player, fetchId, message.start, message.end);
          } else if (message.bl === 'media-cancel') {
            for (const [fetchId, entry] of fetchSources) {
              if (entry.id === message.id && entry.source === event.source) {
                fetchSources.delete(fetchId);
                ctx.module._bl_media_fetch_cancel(fetchId);
              }
            }
          }
        },
        { signal: ctx.signal },
      );
      navigator.serviceWorker.controller?.postMessage({ bl: 'media-hello', instance });
    }
    ctx.module.onEngineMediaFetch = (fetchId, type, data, bytes) => {
      const entry = fetchSources.get(fetchId);
      if (!entry) return;
      if (type === 'end' || type === 'error') fetchSources.delete(fetchId);
      const message = {
        bl: 'media-data',
        instance,
        id: entry.id,
        type,
        data,
        bytes: bytes?.buffer,
      };
      if (bytes) entry.source.postMessage(message, { transfer: [bytes.buffer] });
      else entry.source.postMessage(message);
    };

    ctx.module.onEngineMedia = (id, type, data, bytes) => {
      if (type === 'create') {
        players.get(id)?.destroy();
        players.set(id, new Player(host, id, data as PlayerOptions));
        return;
      }
      const player = players.get(id);
      if (!player) return;
      if (type === 'destroy') {
        player.destroy();
        players.delete(id);
        return;
      }
      player.command(type, data, bytes);
    };

    if (this.pictureInPicture) installPictureInPicture(host);

    ctx.debugState('media', () =>
      [...players.values()].map((player) => {
        const video = player.video;
        const buffered: [number, number][] = [];
        for (let i = 0; i < video.buffered.length; i++)
          buffered.push([video.buffered.start(i), video.buffered.end(i)]);
        return {
          id: player.id,
          time: video.currentTime,
          paused: video.paused,
          width: video.videoWidth,
          frames: player.frames,
          preload: video.preload,
          buffered,
        };
      }),
    );
    ctx.signal.addEventListener('abort', () => {
      for (const player of players.values()) player.destroy();
      players.clear();
      container.remove();
    });
  }
}
