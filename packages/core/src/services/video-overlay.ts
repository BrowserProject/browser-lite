import type { ViewImpl } from '../view.js';

/**
 * Where the engine's compositor punched the hole of a video into a view (#232): `matrix` maps
 * the layer of the video to the device pixels of the view canvas (like CSS `matrix()`), `rect`
 * is the video box in that layer.
 */
export interface VideoPlacement {
  view: number;
  matrix?: [number, number, number, number, number, number];
  rect?: [number, number, number, number];
}

const HIDDEN = 'position:absolute;left:0;top:0;width:2px;height:2px';

/**
 * Shows `video` behind the canvas of `view` at the hole the engine left transparent: page
 * content over the video stays in the canvas on top, clipping and rounded corners come from the
 * hole. The canvas is `position: relative`, so the video before it lies underneath.
 */
export function placeVideo(
  video: HTMLVideoElement,
  view: ViewImpl,
  placement: VideoPlacement,
): void {
  const { matrix, rect } = placement;
  const canvas = view.canvas;
  if (!matrix || !rect || !canvas.isConnected) return;
  // Out of the flow before it goes next to the canvas, which it would push down otherwise
  video.style.position = 'absolute';
  if (video.nextElementSibling !== canvas) canvas.before(video);
  // Device pixels of the engine to CSS pixels of the canvas
  const devicePixels = view.viewSize.width * view.host.pixelRatio();
  const s = devicePixels > 0 ? canvas.clientWidth / devicePixels : 1;
  const [a, b, c, d, e, f] = matrix;
  const [x, y, width, height] = rect;
  const transform = [a * s, b * s, c * s, d * s, (a * x + c * y + e) * s, (b * x + d * y + f) * s];
  video.style.cssText = [
    'position:absolute',
    `left:${canvas.offsetLeft + canvas.clientLeft}px`,
    `top:${canvas.offsetTop + canvas.clientTop}px`,
    `width:${width}px`,
    `height:${height}px`,
    'margin:0',
    'border:0',
    'padding:0',
    'max-width:none',
    'transform-origin:0 0',
    `transform:matrix(${transform.join(',')})`,
    'object-fit:fill',
    'pointer-events:none',
    canvas.style.display === 'none' ? 'visibility:hidden' : '',
  ].join(';');
}

/** Moves `video` back into the hidden container of the media service. */
export function unplaceVideo(video: HTMLVideoElement, container: HTMLElement): void {
  if (video.parentElement === container) return;
  container.append(video);
  video.style.cssText = HIDDEN;
}
