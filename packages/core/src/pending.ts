/**
 * Address of a navigation the host started (load, back, forward, restore) until its document
 * commits or the navigation ends without one, like Chrome's pending entry: an address bar shows
 * it meanwhile instead of the address of the document being left. Navigations of the page itself
 * never set it, so a page cannot make the bar show an address it is not on.
 */
export class PendingNavigation {
  private target = '';

  /** The address, '' without a pending navigation. */
  get url(): string {
    return this.target;
  }

  /** The host starts a navigation to url ('' when its address is unknown). */
  start(url: string): void {
    this.target = url;
  }

  /**
   * Engine `navigation` event: the navigation ended once loading stops (stop, download, failure)
   * or the address arrived (also within the document, which commits nothing).
   */
  update(url: string, loading: boolean): void {
    if (!loading || url === this.target) this.target = '';
  }

  /** It ended (a document committed, the page stayed, the address went to another app); true when one was pending. */
  end(): boolean {
    const was = this.target !== '';
    this.target = '';
    return was;
  }
}
