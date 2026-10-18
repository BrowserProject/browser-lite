import { BrowserLiteError, checkSupport, createBrowser } from '@browser-lite/core';
import { WispTransport } from '@browser-lite/transport-wisp';
import { defaultHandlers, defaultMenuItems, linkStatus, showContextMenu } from '@browser-lite/ui';
import './style.css';

const START_URL = new URLSearchParams(location.search).get('url') ?? 'https://example.com/';

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`#${id} missing`);
  return element as T;
}

const form = byId<HTMLFormElement>('address-form');
const address = byId<HTMLInputElement>('address');
const message = byId<HTMLParagraphElement>('message');

function showMessage(text: string): void {
  message.textContent = text;
  message.hidden = false;
}

/** Address bar text to URL: a scheme is kept, everything else becomes https://. */
function toURL(text: string): string {
  const trimmed = text.trim();
  return /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

async function start(): Promise<void> {
  const support = checkSupport();
  if (!support.supported) {
    showMessage(`This browser cannot run browser-lite (missing: ${support.missing.join(', ')}).`);
    return;
  }
  const browser = await createBrowser({
    // Same origin as the page (the engine starts workers from it)
    engineUrl: new URL('engine/', location.href),
    // The dev server forwards /wisp/ to browser-lite-server
    transport: new WispTransport({ url: new URL('wisp/', location.href) }),
    // sw.js imports media-sw.js: needed for <video> and <audio>
    serviceWorker: { url: new URL('sw.js', location.href) },
    handlers: defaultHandlers(),
  });
  browser.on('warning', ({ message }) => console.warn(message));
  browser.on('crash', () => showMessage('The browser crashed. Reload the page to start again.'));

  const view = browser.createView({ container: byId('view'), url: START_URL });
  // window.open and target=_blank: this example has one view, so the new page replaces its page
  browser.on('new-view', ({ view: popup }) => {
    const off = popup.on('navigation', ({ url }) => {
      if (url === 'about:blank') return;
      off();
      void popup.close({ force: true });
      view.load(url);
    });
  });
  view.on('navigation', ({ url }) => {
    if (document.activeElement !== address) address.value = url;
  });
  view.on('title', ({ title }) => {
    document.title = title || 'browser-lite';
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

start().catch((error: unknown) => {
  const text =
    error instanceof BrowserLiteError ? `${error.code}: ${error.message}` : String(error);
  showMessage(`browser-lite could not start (${text}).`);
});
