/** Frame counts of a player for `getVideoPlaybackQuality()` of the page: total, dropped, corrupted. */
export type PlaybackQuality = [total: number, dropped: number, corrupted: number];

/**
 * Frame counts of a player for the page's `getVideoPlaybackQuality()`. The host `<video>` decodes
 * and shows every frame, so its own counts are the base. When frames are copied into the engine,
 * a frame the host showed but that was never copied (the copy or the engine was too slow) never
 * reached the page: it counts as dropped too, which is what adaptive players react to.
 */
export class FrameQuality {
  private shownFrame = 0;
  private copiedFrame = -1;
  private skipped = 0;

  /** The host showed a frame: `presentedFrames` of its `requestVideoFrameCallback`. */
  presented(presentedFrames: number): void {
    this.shownFrame = presentedFrames;
  }

  /**
   * A frame was copied into the engine. `restart`: the copies start over (seek, copies resumed,
   * view shown again), the frames shown in between were not due.
   */
  copied(restart: boolean): void {
    if (!restart && this.copiedFrame >= 0)
      this.skipped += Math.max(0, this.shownFrame - this.copiedFrame - 1);
    this.copiedFrame = this.shownFrame;
  }

  /** The counts for the engine, undefined where the host has no `getVideoPlaybackQuality()`. */
  counts(video: HTMLVideoElement): PlaybackQuality | undefined {
    if (typeof video.getVideoPlaybackQuality !== 'function') return undefined;
    const quality = video.getVideoPlaybackQuality();
    const total = quality.totalVideoFrames;
    const dropped = Math.min(total, quality.droppedVideoFrames + this.skipped);
    return [total, dropped, quality.corruptedVideoFrames];
  }
}
