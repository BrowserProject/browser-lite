import { modifierBits } from '../../input.js';
import type { ViewImpl } from '../../view.js';
import type { ServiceContext } from '../service.js';
import { flingCurve, VelocityTracker } from './fling.js';

const TAP_DISTANCE = 10;
const LONG_PRESS = 550;

interface TouchResult {
  type: number;
  consumed: boolean;
  pinch: boolean;
  panX?: boolean;
  panY?: boolean;
}

interface Point {
  id: number;
  x: number;
  y: number;
  pinch: boolean;
}

interface Gesture {
  pointerId: number;
  // CSS touch-action where the finger came down: may the view scroll along x, y?
  panX: boolean;
  panY: boolean;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  velocity: VelocityTracker;
  moved: boolean;
  consumed: boolean;
  longPress: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * Fingers go to the page as touch events. When the page does not take them (preventDefault),
 * a swipe scrolls with momentum along the axes CSS touch-action allows (without wheel events),
 * a short tap clicks (the engine, right after the touchend), a long press opens the context
 * menu and two fingers zoom the view, like Chrome. With an emulated touch device the left mouse
 * button is a finger and the mouse without a button moves nothing in the page.
 */
export function installTouch(ctx: ServiceContext): void {
  const results = new WeakMap<ViewImpl, (data: TouchResult) => void>();
  ctx.on<TouchResult>('touch-result', (data, view) => {
    if (view) results.get(view)?.(data);
  });
  const mouseIsTouch = !!ctx.config.device?.touch;
  ctx.onView((view, signal) => attachTouch(ctx, view, signal, mouseIsTouch, results));
}

function attachTouch(
  ctx: ServiceContext,
  view: ViewImpl,
  signal: AbortSignal,
  mouseIsTouch: boolean,
  results: WeakMap<ViewImpl, (data: TouchResult) => void>,
): void {
  const { module } = ctx;
  const canvas = view.canvas;
  const touches = new Map<number, Point>();
  let gesture: Gesture | null = null;
  let fling = 0;
  // Two fingers: pinch zoom of the view like Chrome when the page does not take them
  let pinch: { x: number; y: number; distance: number } | null = null;
  // pointerId per touchstart; the answers come in order
  const startsWithoutResult: number[] = [];

  // tap: the end of a tap, the engine clicks there itself (in the same task as the touchend)
  const send = (type: number, changedId: number, state: number, e: PointerEvent, tap = false) => {
    const points = [...touches.entries()].map(([pointerId, t]) => ({
      id: t.id,
      x: t.x,
      y: t.y,
      state: pointerId === changedId ? state : 3, // 3: stationary
      rx: (e.width || 1) / 2,
      ry: (e.height || 1) / 2,
      force: e.pressure || 0,
    }));
    module._bl_touch(view.id, type, ctx.text(JSON.stringify(points)), modifierBits(e), tap ? 1 : 0);
  };

  const fingers = () => {
    const [a, b] = touches.values() as unknown as [Point, Point];
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, distance: Math.hypot(a.x - b.x, a.y - b.y) };
  };
  const startPinch = () => {
    if (pinch || touches.size !== 2 || ![...touches.values()].every((t) => t.pinch)) return;
    pinch = fingers();
    module._bl_pinch(view.id, 0, 1, pinch.x, pinch.y);
  };
  // phase 2 end, 3 cancel (back to the start of the gesture)
  const stopPinch = (phase: number) => {
    if (!pinch) return;
    module._bl_pinch(view.id, phase, 1, pinch.x, pinch.y);
    pinch = null;
  };

  results.set(view, (data) => {
    if (data.type === 0) {
      const pointerId = startsWithoutResult.shift() ?? -1;
      const touch = touches.get(pointerId);
      if (touch) touch.pinch = data.pinch && !data.consumed;
      if (gesture?.pointerId === pointerId) {
        gesture.panX = data.panX !== false;
        gesture.panY = data.panY !== false;
      }
      startPinch();
    }
    if (data.consumed) {
      if (gesture) gesture.consumed = true;
      stopPinch(3);
    }
  });

  const stopFling = () => {
    cancelAnimationFrame(fling);
    fling = 0;
  };
  const scrollBy = (x: number, y: number, dx: number, dy: number) =>
    module._bl_touch_scroll(view.id, x, y, dx, dy);
  const isTouch = (e: PointerEvent) =>
    e.pointerType === 'touch' || (mouseIsTouch && e.pointerType === 'mouse');
  const options = { capture: true, signal };

  canvas.addEventListener(
    'pointerdown',
    (e) => {
      if (!isTouch(e) || (e.pointerType === 'mouse' && e.button !== 0) || !view.alive) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      view.userInput();
      stopFling();
      canvas.setPointerCapture(e.pointerId);
      const [x, y] = view.position(e);
      touches.set(e.pointerId, { id: e.pointerId, x, y, pinch: false });
      startsWithoutResult.push(e.pointerId);
      send(0, e.pointerId, 1, e);
      if (touches.size === 1) {
        const current: Gesture = {
          pointerId: e.pointerId,
          panX: true,
          panY: true,
          startX: x,
          startY: y,
          lastX: x,
          lastY: y,
          velocity: new VelocityTracker(),
          moved: false,
          consumed: false,
          longPress: false,
          timer: undefined,
        };
        current.timer = setTimeout(() => {
          if (gesture === current && !current.moved && !current.consumed && view.alive) {
            current.longPress = true;
            module._bl_context_menu(view.id, x, y);
          }
        }, LONG_PRESS);
        current.velocity.add(e.timeStamp, x, y);
        gesture = current;
      } else if (gesture) {
        // Second finger: no click and no scrolling for this gesture
        gesture.consumed = true;
      }
    },
    options,
  );

  canvas.addEventListener(
    'pointermove',
    (e) => {
      if (!isTouch(e)) return;
      const touch = touches.get(e.pointerId);
      if (!touch) {
        if (e.pointerType === 'mouse') e.stopImmediatePropagation();
        return;
      }
      e.stopImmediatePropagation();
      if (!view.alive) return;
      const [x, y] = view.position(e);
      touch.x = x;
      touch.y = y;
      send(1, e.pointerId, 2, e);
      if (pinch && touches.size >= 2) {
        const now = fingers();
        if (pinch.distance > 0 && now.distance > 0)
          module._bl_pinch(view.id, 1, now.distance / pinch.distance, now.x, now.y);
        pinch = now;
      }
      if (!gesture || touches.size !== 1) return;
      if (!gesture.moved && Math.hypot(x - gesture.startX, y - gesture.startY) > TAP_DISTANCE) {
        gesture.moved = true;
        clearTimeout(gesture.timer);
      }
      if (gesture.moved && !gesture.consumed) {
        const dx = gesture.panX ? gesture.lastX - x : 0;
        const dy = gesture.panY ? gesture.lastY - y : 0;
        if (dx || dy) scrollBy(x, y, dx, dy);
      }
      gesture.velocity.add(e.timeStamp, x, y);
      gesture.lastX = x;
      gesture.lastY = y;
    },
    options,
  );

  const end = (e: PointerEvent, cancelled: boolean) => {
    const touch = touches.get(e.pointerId);
    if (!isTouch(e) || !touch) return;
    e.stopImmediatePropagation();
    if (!view.alive) {
      touches.delete(e.pointerId);
      return;
    }
    const [x, y] = view.position(e);
    touch.x = x;
    touch.y = y;
    const g = touches.size === 1 ? gesture : null;
    const tap = !!g && !cancelled && !g.consumed && !g.longPress && !g.moved;
    send(cancelled ? 3 : 2, e.pointerId, cancelled ? 4 : 0, e, tap);
    touches.delete(e.pointerId);
    if (touches.size < 2) stopPinch(cancelled ? 3 : 2);
    if (!g) return;
    gesture = null;
    clearTimeout(g.timer);
    if (cancelled || g.consumed || g.longPress || !g.moved) return;
    // Momentum: the page goes on against the direction of the finger
    const finger = g.velocity.release(e.timeStamp, x, y);
    const curve = flingCurve(performance.now(), {
      x: g.panX ? -finger.x : 0,
      y: g.panY ? -finger.y : 0,
    });
    const step = (time: number) => {
      const delta = view.alive ? curve(time) : null;
      if (!delta) {
        fling = 0;
        return;
      }
      scrollBy(x, y, delta.x, delta.y);
      fling = requestAnimationFrame(step);
    };
    fling = requestAnimationFrame(step);
  };
  canvas.addEventListener('pointerup', (e) => end(e, false), options);
  canvas.addEventListener('pointercancel', (e) => end(e, true), options);
  signal.addEventListener('abort', () => {
    stopFling();
    if (gesture) clearTimeout(gesture.timer);
  });
}
