// Stand-ins for MediaStreamTrackProcessor (video) and MediaStreamTrackGenerator where the host
// has neither (Firefox), built from WebCodecs, a <video>, a <canvas> and the engine-audio-feed
// AudioWorklet of the core (audio-worklet.js).

/** Whether the host has what the generator stand-in needs (WebCodecs and AudioWorklet). */
export const canStandIn = (): boolean =>
  typeof VideoFrame === 'function' &&
  typeof AudioData === 'function' &&
  typeof AudioWorkletNode === 'function';

const now = () => Math.round(performance.now() * 1000);
const workletUrl = () => new URL('../audio-worklet.js', import.meta.url).href;

/**
 * Like the readable of a video MediaStreamTrackProcessor: a hidden <video> plays the track,
 * every new frame becomes a VideoFrame (sound goes through the engine-audio-capture worklet,
 * track-source.ts).
 */
export function videoFrames(track: MediaStreamTrack): ReadableStream<VideoFrame> {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = new MediaStream([track]);
  const frameRate = track.getSettings().frameRate || 30;
  // The next frame of the video; a timer without requestVideoFrameCallback
  const nextFrame = () =>
    new Promise<void>((resolve) => {
      if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(() => resolve());
      else setTimeout(resolve, 1000 / frameRate);
    });
  const stop = () => {
    video.pause();
    video.srcObject = null;
  };
  return new ReadableStream<VideoFrame>(
    {
      start: () => video.play().catch(() => {}),
      async pull(controller) {
        while (track.readyState === 'live' && !video.videoWidth) await nextFrame();
        if (track.readyState !== 'live') {
          stop();
          controller.close();
          return;
        }
        controller.enqueue(new VideoFrame(video, { timestamp: now() }));
        await nextFrame();
      },
      cancel: stop,
    },
    { highWaterMark: 0 },
  );
}

/** A host track with a WritableStream for its frames, like MediaStreamTrackGenerator. */
export type WritableTrack = MediaStreamTrack & { writable: WritableStream };

/**
 * Like MediaStreamTrackGenerator: a track whose frames are written into its writable. Video:
 * every VideoFrame is drawn into a <canvas> whose captureStream() is the track. Audio: the
 * AudioData plays through an AudioWorklet into a MediaStreamAudioDestinationNode.
 */
export function writableTrack(kind: string): WritableTrack {
  return kind === 'audio' ? audioTrack() : videoTrack();
}

function videoTrack(): WritableTrack {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  const track = canvas.captureStream().getVideoTracks()[0];
  if (!context || !track) throw new Error('No canvas stream');
  const writable = new WritableStream<VideoFrame>({
    write(frame) {
      try {
        if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
          canvas.width = frame.displayWidth;
          canvas.height = frame.displayHeight;
        }
        context.drawImage(frame, 0, 0);
      } finally {
        frame.close();
      }
    },
    close: () => track.stop(),
    abort: () => track.stop(),
  });
  return Object.assign(track, { writable });
}

function audioTrack(): WritableTrack {
  const context = new AudioContext();
  const destination = context.createMediaStreamDestination();
  const track = destination.stream.getAudioTracks()[0];
  if (!track) throw new Error('No audio stream');
  const feed = context.audioWorklet.addModule(workletUrl()).then(() => {
    const node = new AudioWorkletNode(context, 'engine-audio-feed', { outputChannelCount: [2] });
    node.connect(destination);
    return node;
  });
  context.resume().catch(() => {});
  const stop = () => {
    track.stop();
    if (context.state !== 'closed') context.close().catch(() => {});
  };
  const writable = new WritableStream<AudioData>({
    async write(data) {
      try {
        const planes = Array.from({ length: data.numberOfChannels }, (_, channel) => {
          const plane = new Float32Array(data.numberOfFrames);
          data.copyTo(plane, { planeIndex: channel, format: 'f32-planar' });
          return plane;
        });
        const node = await feed;
        node.port.postMessage(
          { planes, sampleRate: data.sampleRate },
          planes.map((plane) => plane.buffer),
        );
      } finally {
        data.close();
      }
    },
    close: stop,
    abort: stop,
  });
  return Object.assign(track, { writable });
}
