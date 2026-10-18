import { modifierBits } from '../../input.js';
import type { ViewImpl } from '../../view.js';
import type { ServiceContext } from '../service.js';

const TAP_DISTANCE = 10;
const LONG_PRESS = 550;

interface TouchResult {
  type: number;
  consumed: boolean;
  pinch: boolean;
}

interface Point {
  id: number;
  x: number;
  y: number;
  pinch: boolean;
}

interface Gesture {
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  lastTime: number;
  velocityX: number;
  velocityY: number;
  moved: boolean;
  consumed: boolean;
  longPress: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * Fingers go to the page as touch events. When the page does not take them (preventDefault),
 * a swipe scrolls with momentum, a short tap clicks, a long press opens the context menu and two
 * fingers zoom the view, like Chrome. With an emulated touch device the left mouse button is a
 * finger and the mouse without a button moves nothing in the page.
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

  const send = (type: number, changedId: number, state: number, e: PointerEvent) => {
    const points = [...touches.entries()].map(([pointerId, t]) => ({
      id: t.id,
      x: t.x,
      y: t.y,
      state: pointerId === changedId ? state : 3, // 3: stationary
      rx: (e.width || 1) / 2,
      ry: (e.height || 1) / 2,
      force: e.pressure || 0,
    }));
    module._bl_touch(view.id, type, ctx.text(JSON.stringify(points)), modifierBits(e));
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
      const touch = touches.get(startsWithoutResult.shift() ?? -1);
      if (touch) touch.pinch = data.pinch && !data.consumed;
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
    module._bl_wheel(view.id, x, y, dx, dy, 0);
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
          startX: x,
          startY: y,
          lastX: x,
          lastY: y,
          lastTime: e.timeStamp,
          velocityX: 0,
          velocityY: 0,
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
        const dx = gesture.lastX - x;
        const dy = gesture.lastY - y;
        const dt = Math.max(1, e.timeStamp - gesture.lastTime);
        gesture.velocityX = 0.8 * (dx / dt) + 0.2 * gesture.velocityX;
        gesture.velocityY = 0.8 * (dy / dt) + 0.2 * gesture.velocityY;
        scrollBy(x, y, dx, dy);
      }
      gesture.lastX = x;
      gesture.lastY = y;
      gesture.lastTime = e.timeStamp;
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
    send(cancelled ? 3 : 2, e.pointerId, cancelled ? 4 : 0, e);
    touches.delete(e.pointerId);
    if (touches.size < 2) stopPinch(cancelled ? 3 : 2);
    if (!gesture || touches.size) return;
    const g = gesture;
    gesture = null;
    clearTimeout(g.timer);
    if (cancelled || g.consumed || g.longPress) return;
    if (!g.moved) {
      // Tap = click (mouse down and up at the same place)
      module._bl_mouse(view.id, 2, -1, x, y, 0, 0);
      module._bl_mouse(view.id, 0, 0, x, y, 1, 0);
      module._bl_mouse(view.id, 1, 0, x, y, 1, 0);
      return;
    }
    // Momentum: let the velocity decay slowly
    let vx = g.velocityX * 16;
    let vy = g.velocityY * 16;
    const step = () => {
      vx *= 0.95;
      vy *= 0.95;
      if ((Math.abs(vx) < 0.5 && Math.abs(vy) < 0.5) || !view.alive) {
        fling = 0;
        return;
      }
      scrollBy(x, y, vx, vy);
      fling = requestAnimationFrame(step);
    };
    if (Math.hypot(vx, vy) > 2) fling = requestAnimationFrame(step);
  };
  canvas.addEventListener('pointerup', (e) => end(e, false), options);
  canvas.addEventListener('pointercancel', (e) => end(e, true), options);
  signal.addEventListener('abort', () => {
    stopFling();
    if (gesture) clearTimeout(gesture.timer);
  });
}
