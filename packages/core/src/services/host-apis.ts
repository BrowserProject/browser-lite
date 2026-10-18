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
