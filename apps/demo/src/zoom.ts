import type { View } from '@browser-lite/core';
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
