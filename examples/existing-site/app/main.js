// Starts browser-lite in the element with [data-browser] of the page: an address form, a line for
// the page title and messages, and the element the view fills. Plain module, no bundler: the
// import map of the page points the package names to /app/lib/.
import { BrowserLiteError, checkSupport, createBrowser } from '@browser-lite/core';
import { WispTransport } from '@browser-lite/transport-wisp';
import { defaultHandlers, defaultMenuItems, linkStatus, showContextMenu } from '@browser-lite/ui';

const root = document.querySelector('[data-browser]');
const form = root.querySelector('.address-form');
const address = form.querySelector('input');
const title = root.querySelector('.page-title');
const notice = root.querySelector('.notice');
const container = root.querySelector('.view');
const startUrl = new URLSearchParams(location.search).get('url') ?? 'https://example.com/';

function showNotice(text) {
  notice.textContent = text;
  notice.hidden = false;
}

/** A fresh relay token of the signed-in user (the site's session cookie goes along). */
async function relayToken() {
  const response = await fetch('/token', { cache: 'no-store' });
  if (!response.ok) throw new Error(`token: HTTP ${response.status}`);
  return response.text();
}

function toURL(text) {
  const trimmed = text.trim();
  return /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

async function start() {
  const support = checkSupport();
  if (!support.supported) {
    showNotice(`This browser cannot run browser-lite (missing: ${support.missing.join(', ')}).`);
    return;
  }
  const session = await fetch('/session', { cache: 'no-store' });
  if (!session.ok) {
    showNotice(
      session.status === 401
        ? 'Sign in on the home page first.'
        : `Session check failed (HTTP ${session.status}).`,
    );
    return;
  }
  // The site's own service worker; its first line imports media-sw.js of the core
  const registration = await navigator.serviceWorker.register('sw.js');
  const browser = await createBrowser({
    engineUrl: new URL('engine/', location.href),
    transport: new WispTransport({ url: new URL('wisp/', location.href), token: relayToken }),
    serviceWorker: { registration },
    handlers: defaultHandlers(),
    // Own OPFS directory and cache names, apart from other storage of the site
    storage: { namespace: 'example_site' },
  });
  browser.on('warning', ({ code, message }) => showNotice(`${code}: ${message}`));
  browser.on('crash', () => showNotice('The browser crashed. Reload the page to start again.'));

  const view = browser.createView({ container, url: startUrl });
  // window.open and target=_blank: one view only, the new page replaces the current one
  browser.on('new-view', ({ view: popup }) => {
    const off = popup.on('navigation', ({ url }) => {
      if (url === 'about:blank') return;
      off();
      popup.close({ force: true });
      view.load(url);
    });
  });
  view.on('navigation', ({ url }) => {
    if (document.activeElement !== address) address.value = url;
  });
  view.on('title', (event) => {
    title.textContent = event.title;
  });
  view.on('context-menu', (info) => {
    showContextMenu(view, info, defaultMenuItems(view, info, { openTab: (url) => view.load(url) }));
  });
  linkStatus(view);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    view.load(toURL(address.value));
    view.focus();
  });
}

start().catch((error) => {
  const text =
    error instanceof BrowserLiteError ? `${error.code}: ${error.message}` : String(error);
  showNotice(`browser-lite could not start (${text}).`);
});
