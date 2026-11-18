import type { ContextMenuMedia } from './types.js';

const PICTURE_IN_PICTURE = ['unsupported', 'unavailable', 'available', 'active'] as const;

/** `media` of the engine's 'context-menu' event as {@link ContextMenuMedia}, null without one. */
export function menuMedia(value: unknown): ContextMenuMedia | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as Record<string, unknown>;
  const pip = PICTURE_IN_PICTURE.find((state) => state === data.pictureInPicture);
  return {
    type: data.type === 'audio' ? 'audio' : 'video',
    url: String(data.url ?? ''),
    canSave: !!data.canSave,
    loop: !!data.loop,
    canLoop: !!data.canLoop,
    controls: !!data.controls,
    canToggleControls: !!data.canToggleControls,
    pictureInPicture: pip ?? 'unsupported',
  };
}
