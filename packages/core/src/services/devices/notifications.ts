import type { ServiceContext } from '../service.js';

interface NotificationRequest {
  id: string;
  title: string;
  body?: string;
  icon?: string;
  tag?: string;
  lang?: string;
  silent?: boolean;
  persistent?: boolean;
}

/**
 * Notifications of the pages as notifications of the host browser. A click focuses the host
 * window and emits `focus-request` on the view (not for persistent ones of a service worker).
 */
export function installNotifications(ctx: ServiceContext): void {
  const notifications = new Map<string, Notification>();
  ctx.on<NotificationRequest>('notification', (data, view) => {
    const send = (type: number) => {
      if (!ctx.signal.aborted) ctx.module._bl_notification_event(ctx.text(data.id), type);
    };
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') {
      send(3);
      return;
    }
    const notification = new Notification(data.title, {
      body: data.body,
      icon: data.icon || undefined,
      tag: data.tag || undefined,
      lang: data.lang || undefined,
      silent: data.silent,
    });
    notifications.set(data.id, notification);
    notification.addEventListener('show', () => send(0));
    notification.addEventListener('click', () => {
      window.focus();
      if (!data.persistent && view && !view.closed) view.emit('focus-request', {});
      send(1);
    });
    notification.addEventListener('close', () => {
      notifications.delete(data.id);
      send(2);
    });
    notification.addEventListener('error', () => send(3));
  });
  ctx.on<{ id: string }>('notification-close', (data) => notifications.get(data.id)?.close());
  ctx.signal.addEventListener('abort', () => {
    for (const notification of notifications.values()) notification.close();
    notifications.clear();
  });
}
