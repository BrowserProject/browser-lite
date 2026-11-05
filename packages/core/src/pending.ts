// Schemes whose addresses load a document in the view; others (mailto:, javascript:, app links)
// never commit there
const LOADS = new Set(['http:', 'https:', 'file:', 'about:', 'data:']);

/**
 * The address the engine loads for text given to `load` (https:// in front without a scheme, like
 * the engine), '' when it is no address that loads a document in the view or an invalid one, which
 * the engine does not load.
 */
export function loadedAddress(text: string): string {
  const candidate =
    URL.canParse(text) || /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
  if (!URL.canParse(candidate)) return '';
  const url = new URL(candidate);
  return LOADS.has(url.protocol) ? url.href : '';
}

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
