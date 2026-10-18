import { isBookmarked } from './bookmarks.js';
import { startSettings } from './settings.js';
import type { Tab } from './tabs.js';
import { byId, isInternal } from './util.js';

/** Text in the status line of the toolbar. */
export function setStatus(text: string): void {
  byId('status').textContent = text;
}

/** Loading progress of the active tab (0..1); the bar fades out at 1. */
export function setProgress(value: number): void {
  const bar = byId('progress');
  bar.style.opacity = value >= 1 ? '0' : '1';
  bar.style.width = `${Math.round(value * 100)}%`;
}

/** Star of the address bar for the address of the active tab. */
export function updateStar(url: string): void {
  const star = byId<HTMLButtonElement>('bookmark');
  const marked = isBookmarked(url);
  star.textContent = marked ? '★' : '☆';
  star.classList.toggle('active', marked);
  star.disabled = isInternal(url);
}

/**
 * Security indicator like Chrome: a lock for HTTPS (the engine checks the certificate itself, a
 * page with an invalid one does not load), "Not secure" for HTTP and the error page of an
 * invalid certificate, nothing for other error pages.
 */
export function updateSecurity(tab: Tab): void {
  const security = byId('security');
  const form = byId('address-form');
  const url = tab.url || '';
  const certificate = tab.errorPage === 'certificate';
  const https = !tab.errorPage && /^https:/.test(url);
  const insecure = certificate || (!tab.errorPage && /^http:/.test(url));
  security.hidden = !https && !insecure;
  security.textContent = https ? '\u{1F512}' : insecure ? 'Not secure' : '';
  security.title = https
    ? 'Connection is secure (TLS)'
    : certificate
      ? 'The certificate of this site is not valid'
      : insecure
        ? 'The connection to this site is not encrypted'
        : '';
  security.classList.toggle('insecure', insecure);
  form.classList.toggle('with-security', https || insecure);
  form.classList.toggle('insecure', insecure);
}

/** Buttons, zoom, address and security of the toolbar for the active tab. */
export function updateToolbar(tab: Tab): void {
  byId<HTMLButtonElement>('back').disabled = !tab.canGoBack;
  byId<HTMLButtonElement>('forward').disabled = !tab.canGoForward;
  const reload = byId('reload');
  reload.textContent = tab.loading ? '×' : '↻';
  reload.title = tab.loading ? 'Stop' : 'Reload';
  const zoom = byId('zoom');
  zoom.hidden = tab.zoom === startSettings().zoom;
  zoom.textContent = `${Math.round(tab.zoom * 100)} %`;
  const address = byId<HTMLInputElement>('address');
  if (document.activeElement !== address) address.value = tab.url === 'about:blank' ? '' : tab.url;
  updateSecurity(tab);
}
