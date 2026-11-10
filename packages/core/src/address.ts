// Schemes whose addresses load a document in the view; others (mailto:, javascript:, app links)
// never commit there
const LOADS = new Set(['http:', 'https:', 'file:', 'about:', 'data:', 'view-source:']);

// Error pages after which a typed address falls back to http://: no connection or no valid TLS.
// An HTTP error is an answer of the https:// site and stays, like in Chrome
const FALLBACK_ERRORS = new Set(['network', 'certificate']);

/** True for text with a scheme ("https://a.example", "mailto:a"); "localhost:8080" has a port. */
function hasScheme(text: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(text) && !/^[a-z0-9.-]+:\d+(?:[/?#]|$)/i.test(text);
}

/**
 * Where text without a scheme loads, like Chrome's typed navigations: https:// first with the
 * http:// address as fallback, except for addresses https:// rarely serves (localhost, IP
 * addresses, names without a dot, a port other than 80), which load over http:// right away.
 */
function withoutScheme(text: string): { url: string; fallback: string } {
  const candidate = `http://${text}`;
  if (!URL.canParse(candidate)) return { url: '', fallback: '' };
  const http = new URL(candidate);
  const { hostname, port } = http;
  const local =
    port !== '' ||
    !hostname.includes('.') ||
    hostname.endsWith('.localhost') ||
    hostname.startsWith('[') ||
    /^\d+\.\d+\.\d+\.\d+$/.test(hostname);
  if (local) return { url: http.href, fallback: '' };
  return { url: `https:${http.href.slice('http:'.length)}`, fallback: http.href };
}

/**
 * The address `View.load` loads for text typed into an address bar, '' when it loads no
 * document in the view (an invalid address, or a scheme like mailto: that goes to another app).
 * Text with a scheme stays as it is. Without one it gets https:// like in Chrome, which falls back
 * to http:// when the site has no working https://; localhost, IP addresses, names without a dot
 * and addresses with a port other than 80 get http:// (Chrome does not upgrade them either).
 */
export function typedAddress(text: string): string {
  const value = text.trim();
  if (!value) return '';
  const url = hasScheme(value) ? value : withoutScheme(value).url;
  if (!URL.canParse(url)) return '';
  const parsed = new URL(url);
  return LOADS.has(parsed.protocol) ? parsed.href : '';
}

/** The http:// address a load of text falls back to when its https:// address fails, else ''. */
export function httpFallback(text: string): string {
  const value = text.trim();
  return value && !hasScheme(value) ? withoutScheme(value).fallback : '';
}

/**
 * The fallback of a typed address to http:// like Chrome's HTTPS upgrades: when the https://
 * load of text without a scheme fails without an answer of the site (no connection, no valid
 * TLS), the view loads the http:// address once the error page has loaded. The engine reports
 * the failure (`error`), commits its error page (`commit` with its kind) and finishes it
 * (`load`); every other commit and every other navigation of the host ends the fallback.
 */
export class HttpFallback {
  private fallback = '';
  private failed = false;
  private due = false;

  /** The host starts a navigation; fallback is the http:// address, '' without one. */
  start(fallback: string): void {
    this.fallback = fallback;
    this.failed = false;
    this.due = false;
  }

  /** Engine `error`: the navigation failed. */
  error(): void {
    if (this.fallback) this.failed = true;
  }

  /** Engine `commit`: errorPage the kind of the error page, null for a document. */
  commit(errorPage: string | null): void {
    if (this.failed && errorPage && FALLBACK_ERRORS.has(errorPage)) this.due = true;
    else this.start('');
  }

  /** Engine `load`: the http:// address to load now, '' for none. */
  load(): string {
    const url = this.due ? this.fallback : '';
    if (this.due) this.start('');
    return url;
  }
}
