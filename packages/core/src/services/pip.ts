import { domError } from '../util.js';
import type { ViewImpl } from '../view.js';
import type { CaptureApi } from './capture.js';
import { trackGenerator } from './host-apis.js';
import type { MediaHost } from './media.js';

interface TrackInfo {
  kind?: string;
  capture?: number;
  sink?: number;
}

interface PipEvent {
  type: string;
  width?: number;
  height?: number;
}

interface Queue {
  events: PipEvent[];
  wake: (() => void) | null;
}

/**
 * Picture-in-picture of the pages (polyfill in engine WebRTCPolyfill.cpp): the hidden <video>
 * of a player goes into the host's picture-in-picture window. srcObject streams have no player:
 * they get their own hidden <video> with the track (negative ids). The page fetches window
 * events with "pip-wait". The view whose video is in the window gets 'picture-in-picture' events
 * (the host has at most one window).
 */
export function installPictureInPicture(host: MediaHost): void {
  const { ctx, players } = host;
  const queues = new Map<number, Queue>();
  const streamPips = new Map<number, { video: HTMLVideoElement; track: MediaStreamTrack }>();
  let nextStreamPip = -1;
  let pipVideo: HTMLVideoElement | null = null;
  let pipView: ViewImpl | undefined;

  const entered = (video: HTMLVideoElement, view: ViewImpl | undefined) => {
    const previous = pipView;
    pipVideo = video;
    pipView = view;
    if (previous === view) return;
    previous?.emit('picture-in-picture', { active: false });
    view?.emit('picture-in-picture', { active: true });
  };
  const left = (video: HTMLVideoElement) => {
    if (video !== pipVideo) return;
    const view = pipView;
    pipVideo = null;
    pipView = undefined;
    view?.emit('picture-in-picture', { active: false });
  };

  const queueOf = (id: number) => {
    let queue = queues.get(id);
    if (!queue) {
      queue = { events: [], wake: null };
      queues.set(id, queue);
    }
    return queue;
  };

  const push = (id: number, event: PipEvent) => {
    const queue = queueOf(id);
    queue.events.push(event);
    queue.wake?.();
  };

  const closeStreamPip = (id: number) => {
    const pip = streamPips.get(id);
    if (!pip) return;
    streamPips.delete(id);
    pip.track.stop();
    pip.video.srcObject = null;
    pip.video.remove();
  };

  const notAvailable = () =>
    domError('NotSupportedError', 'Picture-in-Picture is not available for this video.');

  const enterStream = async (info: TrackInfo | undefined, view: ViewImpl | undefined) => {
    if (info?.kind !== 'video') throw notAvailable();
    let track: MediaStreamTrack;
    const generate = trackGenerator();
    if (info.capture) {
      const original = await ctx.use<CaptureApi>('capture')?.track(info.capture);
      if (!original || original.readyState === 'ended')
        throw domError('InvalidStateError', 'The track has ended.');
      track = original.clone();
    } else if (info.sink && generate) {
      const worker = ctx.engineWorker();
      if (!worker) throw domError('InvalidStateError', 'No engine');
      const generator = generate('video');
      worker.postMessage({ blSink: { id: info.sink, writable: generator.writable } }, [
        generator.writable,
      ]);
      track = generator;
    } else throw notAvailable();
    const id = nextStreamPip--;
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = new MediaStream([track]);
    host.container.append(video);
    streamPips.set(id, { video, track });
    try {
      if (video.readyState < 1)
        await new Promise((resolve, reject) => {
          video.addEventListener('loadedmetadata', resolve, { once: true });
          setTimeout(() => reject(domError('InvalidStateError', 'The video has no frames.')), 5000);
        });
      await video.play().catch(() => {});
      video.addEventListener(
        'leavepictureinpicture',
        () => {
          push(id, { type: 'leave' });
          closeStreamPip(id);
          left(video);
        },
        { once: true },
      );
      track.addEventListener('ended', () => {
        if (document.pictureInPictureElement === video)
          document.exitPictureInPicture().catch(() => {});
      });
      queueOf(id).events.length = 0;
      const pipWindow = await video.requestPictureInPicture();
      entered(video, view);
      pipWindow.addEventListener('resize', () =>
        push(id, { type: 'resize', width: pipWindow.width, height: pipWindow.height }),
      );
      return { stream: id, width: pipWindow.width, height: pipWindow.height };
    } catch (error) {
      closeStreamPip(id);
      throw error;
    }
  };

  const enterPlayer = async (payload: { player?: number } | null, view: ViewImpl | undefined) => {
    const id = Number(payload?.player);
    const player = players.get(id);
    if (!player) throw domError('InvalidStateError', 'The video is gone.');
    if (!document.pictureInPictureEnabled)
      throw domError('NotSupportedError', 'Picture-in-Picture is disabled.');
    const video = player.video;
    if (!player.pipHooked) {
      player.pipHooked = true;
      video.addEventListener('leavepictureinpicture', () => {
        push(id, { type: 'leave' });
        left(video);
      });
    }
    queueOf(id).events.length = 0;
    const pipWindow = await video.requestPictureInPicture();
    entered(video, view);
    pipWindow.addEventListener('resize', () =>
      push(id, { type: 'resize', width: pipWindow.width, height: pipWindow.height }),
    );
    return { width: pipWindow.width, height: pipWindow.height };
  };

  ctx.hostCall<{ player?: number; track?: TrackInfo } | null>(
    'pip-enter',
    (payload, _origin, view) =>
      payload?.track ? enterStream(payload.track, view) : enterPlayer(payload, view),
  );
  ctx.hostCall('pip-exit', async () => {
    if (document.pictureInPictureElement) await document.exitPictureInPicture();
    return {};
  });
  ctx.hostCall<{ player?: number } | null>('pip-wait', async (payload) => {
    const id = Number(payload?.player);
    const queue = queueOf(id);
    if (!queue.events.length) {
      await new Promise<void>((resolve) => {
        queue.wake = resolve;
        setTimeout(resolve, 20000);
      });
      queue.wake = null;
    }
    // Player gone: the window is closed
    if (id < 0 ? !streamPips.has(id) && !queue.events.length : !players.has(id))
      return { type: 'leave' };
    return queue.events.shift() ?? { type: 'none' };
  });
  ctx.signal.addEventListener('abort', () => {
    for (const id of [...streamPips.keys()]) closeStreamPip(id);
    for (const queue of queues.values()) queue.wake?.();
  });
}
