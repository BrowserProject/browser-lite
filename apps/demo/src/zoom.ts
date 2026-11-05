import type { View } from '@browser-lite/core';
import { profile } from './runtime.js';
import { startSettings, ZOOM_LEVELS } from './settings.js';

/**
 * One zoom level up (direction 1) or down (-1) like Chrome; 0 goes back to the default zoom of
 * the settings. Ctrl + mouse wheel zooms in the core, the view reports it with 'zoom'.
 */
export function changeZoom(view: View, direction: 1 | -1 | 0): void {
  if (!direction) {
    view.setZoom(startSettings().zoom);
    return;
  }
  const zoom = view.zoom;
  const index = ZOOM_LEVELS.findIndex((level) => level >= zoom - 0.001);
  const last = ZOOM_LEVELS.length - 1;
  let next: number | undefined;
  if (index < 0) next = direction > 0 ? zoom : ZOOM_LEVELS[last];
  else if (direction > 0)
    next = ZOOM_LEVELS[Math.min(index + ((ZOOM_LEVELS[index] ?? 0) > zoom + 0.001 ? 0 : 1), last)];
  else next = ZOOM_LEVELS[Math.max(index - 1, 0)];
  if (next !== undefined) view.setZoom(next);
}

/** Zoom per host in the pref `site-zoom` of the profile: { host: factor }, none at the default. */
const levels = () => profile.prefs<Record<string, number>>('site-zoom') ?? {};

/**
 * Host a zoom belongs to like Chrome: the host name of an http(s) address without the port, ''
 * for other addresses (new tab page, data:, file:), whose zoom stays with the tab.
 */
export function zoomHost(url: string): string {
  const parsed = URL.parse(url);
  return parsed && /^https?:$/.test(parsed.protocol) ? parsed.hostname : '';
}

/** Zoom of host: the remembered one, else the default zoom of the settings. */
export function siteZoom(host: string): number {
  const zoom = host ? levels()[host] : undefined;
  return typeof zoom === 'number' && zoom > 0 ? zoom : startSettings().zoom;
}

/** Remembers zoom for host (no entry at the default zoom). */
export function rememberSiteZoom(host: string, zoom: number): void {
  if (!host || siteZoom(host) === zoom) return;
  const next = { ...levels() };
  if (zoom === startSettings().zoom) delete next[host];
  else next[host] = zoom;
  profile.savePrefs('site-zoom', next);
}
