import { canStandIn, type WritableTrack, writableTrack } from './track-streams.js';

/** Host browser APIs that are missing from the TypeScript DOM library. */

export type TrackProcessor = new (init: {
  track: MediaStreamTrack;
}) => { readable: ReadableStream };

type TrackGenerator = new (init: { kind: string }) => WritableTrack;

/** MediaStreamTrackProcessor of the main thread (Chromium), undefined elsewhere. */
export const trackProcessor = (): TrackProcessor | undefined =>
  (globalThis as { MediaStreamTrackProcessor?: TrackProcessor }).MediaStreamTrackProcessor;

/**
 * Makes a host track of kind that the engine worker writes frames into: a
 * MediaStreamTrackGenerator (Chromium), else the stand-in of track-streams.ts (Firefox),
 * undefined without WebCodecs.
 */
export function trackGenerator(): ((kind: string) => WritableTrack) | undefined {
  const Generator = (globalThis as { MediaStreamTrackGenerator?: TrackGenerator })
    .MediaStreamTrackGenerator;
  if (Generator) return (kind) => new Generator({ kind });
  return canStandIn() ? writableTrack : undefined;
}

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
