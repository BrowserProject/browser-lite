import { modifierBits } from '../../input.js';
import type { ViewImpl } from '../../view.js';
import type { ServiceContext } from '../service.js';
import { engineFlingVelocity, VelocityTracker } from './fling.js';
import { type PinchFinger, TouchPinch } from './touch-pinch.js';

const TAP_DISTANCE = 10;
const LONG_PRESS = 550;

interface TouchResult {
  type: number;
  consumed: boolean;
  pinch: boolean;
  panX?: boolean;
  panY?: boolean;
}

interface Point extends PinchFinger {
  id: number;
}

interface Gesture {
  finger: Point;
  // CSS touch-action where the finger came down: may the view scroll along x, y?
  panX: boolean;
  panY: boolean;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  velocity: VelocityTracker;
  // The view scrolled with this gesture (bl_touch_scroll phase 1 sent)
  scrolled: boolean;
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
  // The two fingers on the view zoom it like Chrome when the page does not take them
  let pinch: TouchPinch | null = null;
  // What every touch event sent to the engine belongs to; the answers come in order
  const answers: { start?: Point; gesture: Gesture | null; pinch: TouchPinch | null }[] = [];

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
    answers.push({ start: type === 0 ? touches.get(changedId) : undefined, gesture, pinch });
    module._bl_touch(view.id, type, ctx.text(JSON.stringify(points)), modifierBits(e), tap ? 1 : 0);
  };

  results.set(view, (data) => {
    const { start, gesture: g, pinch: p } = answers.shift() ?? { gesture: null, pinch: null };
    if (start) {
      start.pinch = data.pinch && !data.consumed;
      if (g?.finger === start) {
        g.panX = data.panX !== false;
        g.panY = data.panY !== false;
      }
    }
    if (data.consumed && g) g.consumed = true;
    // preventDefault on a touchstart or touchmove: the page takes the fingers. The answer to the
    // second finger's touchstart decides the pinch, the first one's came before
    if (data.consumed && data.type < 2) p?.cancel();
    else if (start && start === p?.fingers[1]) p.answered();
  });

  // A scroll gesture for the engine (it flings and snaps itself): 0 the finger is down, 1 the
  // first move, 2 further moves, 3 lifted with the velocity of the fling (px/s). Every event of a
  // gesture goes to where it began, so all of it scrolls the same box
  const touchScroll = (g: Gesture, phase: number, dx = 0, dy = 0) =>
    module._bl_touch_scroll(view.id, g.startX, g.startY, dx, dy, phase);
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
      canvas.setPointerCapture(e.pointerId);
      const [x, y] = view.position(e);
      const finger: Point = { id: e.pointerId, x, y };
      touches.set(e.pointerId, finger);
      if (touches.size === 1) {
        const current: Gesture = {
          finger,
          panX: true,
          panY: true,
          startX: x,
          startY: y,
          lastX: x,
          lastY: y,
          velocity: new VelocityTracker(),
          scrolled: false,
          moved: false,
          consumed: false,
          longPress: false,
          timer: undefined,
        };
        current.timer = setTimeout(() => {
          if (gesture === current && !current.moved && !current.consumed && view.alive) {
            current.longPress = true;
            view.requestContextMenu(x, y, true);
          }
        }, LONG_PRESS);
        current.velocity.add(e.timeStamp, x, y);
        gesture = current;
        send(0, e.pointerId, 1, e);
        // A finger on the page stops a fling
        touchScroll(current, 0);
        return;
      }
      // Second finger: no click and no scrolling for this gesture, but a pinch
      if (gesture) gesture.consumed = true;
      if (!pinch && touches.size === 2) {
        const [first] = touches.values() as unknown as [Point];
        pinch = new TouchPinch([first, finger], (phase, factor, px, py) =>
          module._bl_pinch(view.id, phase, factor, px, py),
        );
      }
      send(0, e.pointerId, 1, e);
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
      if (pinch?.fingers.includes(touch)) pinch.moved();
      if (!gesture || touches.size !== 1) return;
      if (!gesture.moved && Math.hypot(x - gesture.startX, y - gesture.startY) > TAP_DISTANCE) {
        gesture.moved = true;
        clearTimeout(gesture.timer);
      }
      if (gesture.moved && !gesture.consumed) {
        const dx = gesture.panX ? gesture.lastX - x : 0;
        const dy = gesture.panY ? gesture.lastY - y : 0;
        if (dx || dy) {
          touchScroll(gesture, gesture.scrolled ? 2 : 1, dx, dy);
          gesture.scrolled = true;
        }
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
    if (pinch?.fingers.includes(touch)) {
      pinch.lift(cancelled);
      pinch = null;
    }
    if (!g) return;
    gesture = null;
    clearTimeout(g.timer);
    // The end of the gesture: the page flings on against the direction of the finger, or stays
    // (at the nearest snap point)
    const fling = !cancelled && !g.consumed && g.scrolled;
    const finger = fling ? g.velocity.release(e.timeStamp, x, y) : { x: 0, y: 0 };
    const page = engineFlingVelocity({ x: g.panX ? -finger.x : 0, y: g.panY ? -finger.y : 0 });
    touchScroll(g, 3, page.x, page.y);
  };
  // A finger (also an emulated one) leaves the screen, not the view: no mouse leave for the page
  canvas.addEventListener(
    'pointerleave',
    (e) => {
      if (isTouch(e)) e.stopImmediatePropagation();
    },
    options,
  );
  canvas.addEventListener('pointerup', (e) => end(e, false), options);
  canvas.addEventListener('pointercancel', (e) => end(e, true), options);
  signal.addEventListener('abort', () => {
    if (gesture) clearTimeout(gesture.timer);
  });
}
