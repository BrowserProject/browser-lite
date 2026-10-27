import { canStandIn, TrackReader, type WritableTrack, writableTrack } from './track-streams.js';

/** Host browser APIs that are missing from the TypeScript DOM library. */

export type TrackProcessor = new (init: {
  track: MediaStreamTrack;
}) => { readable: ReadableStream };

type TrackGenerator = new (init: { kind: string }) => WritableTrack;

/**
 * MediaStreamTrackProcessor (Chromium), else the stand-in of track-streams.ts (Firefox),
 * undefined without WebCodecs.
 */
export const trackProcessor = (): TrackProcessor | undefined =>
  (globalThis as { MediaStreamTrackProcessor?: TrackProcessor }).MediaStreamTrackProcessor ??
  (canStandIn() ? TrackReader : undefined);

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
