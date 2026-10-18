import type { View } from '../../types.js';
import type { ViewImpl } from '../../view.js';
import type { ServiceContext } from '../service.js';

interface NotificationEvent {
  id: string;
  title: string;
  body?: string;
  icon?: string;
  tag?: string;
  lang?: string;
  silent?: boolean;
  persistent?: boolean;
}

/** A notification of a page (Notification or showNotification of a service worker). */
export interface PageNotification {
  /** View of the page, null for a service worker. */
  readonly view: View | null;
  readonly title: string;
  readonly body: string;
  /**
   * Icon as a data: URL, '' otherwise: an address would load past the transport and reveal the
   * IP address of the device.
   */
  readonly icon: string;
  readonly tag: string;
  readonly lang: string;
  readonly silent: boolean;
  /** From a service worker (registration.showNotification). */
  readonly persistent: boolean;
  /** Aborted when the page closes the notification (remove it, then call `closed()`) or the browser ends. */
  readonly signal: AbortSignal;
  /** Tell the page the notification is visible (show event). */
  shown(): void;
  /** Tell the page the user clicked it (click event, notificationclick in a service worker). */
  clicked(): void;
  /** Tell the page the notification is gone (close event). */
  closed(): void;
  /** Tell the page it could not be shown (error event). */
  failed(): void;
}

/** Shows the notifications of the pages, for example in the UI of the integrator. */
export interface NotificationHandler {
  show(notification: PageNotification): void;
}

const SHOWN = 0;
const CLICKED = 1;
const CLOSED = 2;
const FAILED = 3;

/**
 * Default: notifications of the host browser (only when the host allowed them). A click focuses
 * the host window and emits `focus-request` on the view (not for persistent ones).
 */
function showOnHost(page: PageNotification, view: ViewImpl | undefined): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') {
    page.failed();
    return;
  }
  const notification = new Notification(page.title, {
    body: page.body,
    icon: page.icon || undefined,
    tag: page.tag || undefined,
    lang: page.lang || undefined,
    silent: page.silent,
  });
  notification.addEventListener('show', () => page.shown());
  notification.addEventListener('click', () => {
    window.focus();
    if (!page.persistent && view && !view.closed) view.emit('focus-request', {});
    page.clicked();
  });
  notification.addEventListener('close', () => page.closed());
  notification.addEventListener('error', () => page.failed());
  page.signal.addEventListener('abort', () => notification.close(), { once: true });
}

/** Notifications of the pages (engine DeviceClients.cpp) through a {@link NotificationHandler}. */
export function installNotifications(ctx: ServiceContext, handler?: NotificationHandler): void {
  const open = new Map<string, AbortController>();
  ctx.on<NotificationEvent>('notification', (data, view) => {
    const controller = new AbortController();
    open.get(data.id)?.abort();
    open.set(data.id, controller);
    const send = (type: number) => {
      if (ctx.signal.aborted || open.get(data.id) !== controller) return;
      if (type === CLOSED || type === FAILED) open.delete(data.id);
      ctx.module._bl_notification_event(ctx.text(data.id), type);
    };
    const icon = data.icon ?? '';
    const notification: PageNotification = {
      view: view ?? null,
      title: data.title,
      body: data.body ?? '',
      icon: icon.startsWith('data:') ? icon : '',
      tag: data.tag ?? '',
      lang: data.lang ?? '',
      silent: !!data.silent,
      persistent: !!data.persistent,
      signal: controller.signal,
      shown: () => send(SHOWN),
      clicked: () => send(CLICKED),
      closed: () => send(CLOSED),
      failed: () => send(FAILED),
    };
    try {
      if (handler) handler.show(notification);
      else showOnHost(notification, view);
    } catch (error) {
      console.warn('[browser-lite] notification handler failed:', error);
      send(FAILED);
    }
  });
  ctx.on<{ id: string }>('notification-close', (data) => open.get(data.id)?.abort());
  ctx.signal.addEventListener('abort', () => {
    for (const controller of open.values()) controller.abort();
    open.clear();
  });
}
