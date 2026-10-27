/** How many unlocked elements wait for new players. */
const SPARES = 2;

/**
 * Safari plays a media element with sound only after a `play()` of that element inside a user
 * gesture of the host page; the engine's play commands come later, from the engine thread. So
 * every gesture unlocks the elements of the players that were never unlocked (play and pause at
 * once) and keeps a few unlocked spare elements for players the page creates afterwards. In
 * Chromium the user activation of the page is enough; the calls cost nothing there.
 */
export class MediaUnlock {
  private readonly spares: HTMLVideoElement[] = [];
  private pending = 0;
  private readonly unlocked = new WeakSet<HTMLVideoElement>();

  /** A video element for a new player: an unlocked spare if there is one. */
  take(): HTMLVideoElement {
    return this.spares.pop() ?? document.createElement('video');
  }

  /** The element played (a play command succeeded). */
  played(video: HTMLVideoElement): void {
    this.unlocked.add(video);
  }

  /** Runs inside the activation events of the host page. */
  gesture(videos: Iterable<HTMLVideoElement>): void {
    for (const video of videos) {
      if (this.unlocked.has(video)) continue;
      if (!video.paused) this.unlocked.add(video);
      else this.unlock(video, () => {});
    }
    while (this.spares.length + this.pending < SPARES) {
      const video = document.createElement('video');
      this.pending++;
      this.unlock(video, (ok) => {
        this.pending--;
        if (ok) this.spares.push(video);
      });
    }
  }

  private unlock(video: HTMLVideoElement, done: (ok: boolean) => void): void {
    // Rejected at once with NotAllowedError outside a gesture (iOS: pointerdown), otherwise
    // pause() aborts the playback and the restriction of the element is gone
    video.play().then(
      () => {
        this.unlocked.add(video);
        done(true);
      },
      (error: unknown) => {
        const ok = (error as Error | null)?.name !== 'NotAllowedError';
        if (ok) this.unlocked.add(video);
        done(ok);
      },
    );
    video.pause();
  }
}
