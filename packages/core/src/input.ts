import type { ViewImpl } from './view.js';

/** Zoom steps of Ctrl + mouse wheel (like Chrome). */
export const ZOOM_LEVELS = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5,
];

/** Next zoom level up (direction 1) or down (-1) from zoom. */
export function zoomStep(zoom: number, direction: 1 | -1): number {
  const index = ZOOM_LEVELS.findIndex((level) => level >= zoom - 0.001);
  if (index < 0) return direction > 0 ? zoom : (ZOOM_LEVELS.at(-1) as number);
  const level = ZOOM_LEVELS[index] as number;
  return direction > 0
    ? (ZOOM_LEVELS[
        Math.min(index + (level > zoom + 0.001 ? 0 : 1), ZOOM_LEVELS.length - 1)
      ] as number)
    : (ZOOM_LEVELS[Math.max(index - 1, 0)] as number);
}

/** Modifier flags of the engine input exports. */
export function modifierBits(e: {
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  getModifierState?: (key: string) => boolean;
}): number {
  return (
    (e.shiftKey ? 1 : 0) |
    (e.ctrlKey ? 2 : 0) |
    (e.altKey ? 4 : 0) |
    (e.metaKey ? 8 : 0) |
    (e.getModifierState?.('CapsLock') ? 16 : 0)
  );
}

interface Pinch {
  x: number;
  y: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  owner: null | 'page' | 'view';
  queued: WheelEvent[];
  ended: boolean;
}

/**
 * Mouse, wheel, touchpad pinch and drag and drop on the canvas of a view. Touch comes first
 * when the devices service handles it (capture listeners).
 */
export function attachPointerInput(view: ViewImpl, signal: AbortSignal): void {
  const canvas = view.canvas;
  const module = view.host.module;
  const on = <K extends keyof HTMLElementEventMap>(
    type: K,
    listener: (event: HTMLElementEventMap[K]) => void,
    passive = true,
  ) => canvas.addEventListener(type, (event) => view.alive && listener(event), { signal, passive });

  const wheelDelta = (e: WheelEvent): [number, number] => {
    const factor = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1; // lines, pages
    return [e.deltaX * factor, e.deltaY * factor];
  };

  // Ctrl + wheel goes to the page first like Chrome (maps and editors zoom themselves); the
  // view zooms only without preventDefault. Without a blocking wheel listener at the point at
  // once, otherwise after the answer of the engine (wheel-result, in order).
  const wheelAnswers: ((consumed: boolean) => void)[] = [];
  view.onWheelResult = (consumed) => wheelAnswers.shift()?.(consumed);
  const zoomWheel = (e: WheelEvent, cancelable: boolean, answer: (consumed: boolean) => void) => {
    const [x, y] = view.position(e);
    const [dx, dy] = wheelDelta(e);
    if (module._bl_zoom_wheel(view.id, x, y, dx, dy, modifierBits(e), cancelable ? 1 : 0))
      wheelAnswers.push(answer);
    else answer(false);
  };

  // Touchpad pinch arrives as many small wheel events with ctrlKey (fractional deltas): like
  // Chrome only the view scales (engine PinchZoom.h), around the pointer. The first event
  // decides: if the page calls preventDefault the whole gesture is the page's, otherwise it
  // only reads along. The gesture ends after a pause or before other input.
  let pinch: Pinch | null = null;
  const pinchStep = (e: WheelEvent) => {
    if (!pinch) return;
    const owned = pinch.owner === 'view';
    zoomWheel(e, !owned, () => {});
    if (owned) module._bl_pinch(view.id, 1, Math.exp(-e.deltaY / 100), pinch.x, pinch.y);
  };
  const endPinch = () => {
    if (!pinch) return;
    clearTimeout(pinch.timer);
    if (pinch.owner === 'view') module._bl_pinch(view.id, 2, 1, pinch.x, pinch.y);
    pinch = null;
  };
  const touchpadPinch = (e: WheelEvent) => {
    if (!pinch) {
      const [x, y] = view.position(e);
      const gesture: Pinch = { x, y, timer: undefined, owner: null, queued: [], ended: false };
      pinch = gesture;
      zoomWheel(e, true, (consumed) => {
        if (pinch !== gesture) return; // ended by other input before
        gesture.owner = consumed ? 'page' : 'view';
        if (!consumed) {
          module._bl_pinch(view.id, 0, 1, x, y);
          module._bl_pinch(view.id, 1, Math.exp(-e.deltaY / 100), x, y);
        }
        for (const queued of gesture.queued.splice(0)) pinchStep(queued);
        if (gesture.ended) endPinch();
      });
    } else if (!pinch.owner) {
      pinch.queued.push(e);
    } else {
      pinchStep(e);
    }
    const gesture = pinch;
    gesture.ended = false;
    clearTimeout(gesture.timer);
    gesture.timer = setTimeout(() => {
      if (gesture.owner) endPinch();
      else gesture.ended = true;
    }, 200);
  };

  // Click count (double/triple click selects word/paragraph, dblclick) counted here:
  // PointerEvent.detail is always 0 in Chrome
  let lastDown = { time: 0, x: 0, y: 0, button: -1, count: 0 };
  on(
    'pointerdown',
    (e) => {
      view.userInput();
      endPinch();
      canvas.setPointerCapture(e.pointerId);
      const [x, y] = view.position(e);
      const repeated =
        e.button === lastDown.button &&
        e.timeStamp - lastDown.time < 500 &&
        Math.abs(x - lastDown.x) <= 4 &&
        Math.abs(y - lastDown.y) <= 4;
      lastDown = {
        time: e.timeStamp,
        x,
        y,
        button: e.button,
        count: repeated ? lastDown.count + 1 : 1,
      };
      module._bl_mouse(view.id, 0, e.button, x, y, lastDown.count, modifierBits(e));
      view.host.watchdog.inputSent();
      e.preventDefault();
    },
    false,
  );
  on('pointerup', (e) => {
    endPinch();
    const [x, y] = view.position(e);
    const count = e.button === lastDown.button ? lastDown.count : 1;
    module._bl_mouse(view.id, 1, e.button, x, y, count, modifierBits(e));
  });
  on('pointermove', (e) => {
    // Pressed button (e.buttons: 1 left, 2 right, 4 middle), otherwise no dragging
    const button = e.buttons & 1 ? 0 : e.buttons & 4 ? 1 : e.buttons & 2 ? 2 : -1;
    const [x, y] = view.position(e);
    module._bl_mouse_move(
      view.id,
      x,
      y,
      e.movementX || 0,
      e.movementY || 0,
      button,
      modifierBits(e),
    );
  });
  on(
    'contextmenu',
    (e) => {
      e.preventDefault();
      endPinch();
      const [x, y] = view.position(e);
      module._bl_context_menu(view.id, x, y);
    },
    false,
  );
  on(
    'wheel',
    (e) => {
      e.preventDefault();
      if (e.ctrlKey && !e.altKey && e.deltaY) {
        // Ctrl + mouse wheel: one zoom level per notch like Chrome
        if (e.deltaMode !== 0 || (Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 50)) {
          const direction = e.deltaY < 0 ? 1 : -1;
          zoomWheel(e, true, (consumed) => {
            if (!consumed && view.alive) view.setZoom(zoomStep(view.zoom, direction));
          });
          return;
        }
        touchpadPinch(e);
        return;
      }
      endPinch();
      const [x, y] = view.position(e);
      const [dx, dy] = wheelDelta(e);
      module._bl_wheel(view.id, x, y, dx, dy, modifierBits(e));
    },
    false,
  );

  // Drag and drop from the system or another window (files, text, links). While dragging the
  // page sees only the types and the number of files like Chrome, the data comes on drop
  // (files into the engine file system like uploads, engine WebView.cpp hostDrag).
  const dragSummary = (dataTransfer: DataTransfer | null) => {
    const summary: Record<string, unknown> = { fileCount: 0 };
    let files = 0;
    for (const item of dataTransfer?.items ?? []) if (item.kind === 'file') files++;
    summary.fileCount = files;
    const types = [...(dataTransfer?.types ?? [])];
    if (types.includes('text/plain')) summary.text = '';
    if (types.includes('text/html')) summary.html = '';
    if (types.includes('text/uri-list')) summary.uriList = '';
    return summary;
  };
  const sendDrag = (phase: number, point: [number, number], modifiers: number, data: unknown) =>
    module._bl_drag(
      view.id,
      phase,
      point[0],
      point[1],
      modifiers,
      view.host.text(JSON.stringify(data)),
    );
  on('dragenter', (e) => e.preventDefault(), false);
  on(
    'dragover',
    (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      sendDrag(0, view.position(e), modifierBits(e), dragSummary(e.dataTransfer));
    },
    false,
  );
  on('dragleave', (e) => sendDrag(1, view.position(e), modifierBits(e), {}));
  on(
    'drop',
    async (e) => {
      e.preventDefault();
      const dataTransfer = e.dataTransfer;
      const data: Record<string, unknown> = {};
      for (const [key, type] of [
        ['text', 'text/plain'],
        ['html', 'text/html'],
        ['uriList', 'text/uri-list'],
      ] as const) {
        const value = dataTransfer?.getData(type);
        if (value) data[key] = value;
      }
      // After an await the data of the event is gone
      const files = [...(dataTransfer?.files ?? [])];
      const point = view.position(e);
      const modifiers = modifierBits(e);
      const paths = await view.host.uploads.write(view, files);
      data.files = paths;
      data.fileCount = paths.length;
      if (view.alive) sendDrag(2, point, modifiers, data);
    },
    false,
  );
}
