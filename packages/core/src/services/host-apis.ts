/** Host browser APIs that are missing from the TypeScript DOM library. */

export type TrackProcessor = new (init: {
  track: MediaStreamTrack;
}) => { readable: ReadableStream };

export type TrackGenerator = new (init: {
  kind: string;
}) => MediaStreamTrack & { writable: WritableStream };

/** MediaStreamTrackProcessor (Chromium), undefined elsewhere. */
export const trackProcessor = (): TrackProcessor | undefined =>
  (globalThis as { MediaStreamTrackProcessor?: TrackProcessor }).MediaStreamTrackProcessor;

/** MediaStreamTrackGenerator (Chromium), undefined elsewhere. */
export const trackGenerator = (): TrackGenerator | undefined =>
  (globalThis as { MediaStreamTrackGenerator?: TrackGenerator }).MediaStreamTrackGenerator;

/**
 * MediaSource of the host: iPhone Safari has only ManagedMediaSource, which also needs
 * `disableRemotePlayback` on its element (or an AirPlay alternative) to open.
 */
export const mediaSourceClass = ():
  | { Source: typeof MediaSource; managed: boolean }
  | undefined => {
  const scope = globalThis as {
    MediaSource?: typeof MediaSource;
    ManagedMediaSource?: typeof MediaSource;
  };
  if (scope.MediaSource) return { Source: scope.MediaSource, managed: false };
  if (scope.ManagedMediaSource) return { Source: scope.ManagedMediaSource, managed: true };
  return undefined;
};
