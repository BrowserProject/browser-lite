import { orNaN } from '../../util.js';
import type { ViewImpl } from '../../view.js';
import type { ServiceContext } from '../service.js';

type Kind = 'orientation' | 'motion';

/**
 * Device orientation and motion: one listener on the host event per view and kind while the
 * page listens itself. Only visible views get values.
 */
export function installSensors(ctx: ServiceContext): void {
  const listeners = new Map<string, (event: Event) => void>();
  const eventName = (kind: Kind) => (kind === 'orientation' ? 'deviceorientation' : 'devicemotion');

  const stop = (view: ViewImpl, kind: Kind) => {
    const key = `${view.id}:${kind}`;
    const listener = listeners.get(key);
    if (!listener) return;
    removeEventListener(eventName(kind), listener);
    listeners.delete(key);
  };

  ctx.on<{ kind: Kind }>('sensor-start', (data, view) => {
    if (!view || (data.kind !== 'orientation' && data.kind !== 'motion')) return;
    stop(view, data.kind);
    const { module } = ctx;
    const listener =
      data.kind === 'orientation'
        ? (event: Event) => {
            const e = event as DeviceOrientationEvent;
            if (view.visibleNow)
              module._bl_device_orientation(
                view.id,
                orNaN(e.alpha),
                orNaN(e.beta),
                orNaN(e.gamma),
                e.absolute ? 1 : 0,
              );
          }
        : (event: Event) => {
            const e = event as DeviceMotionEvent;
            if (!view.visibleNow) return;
            const a = e.acceleration;
            const g = e.accelerationIncludingGravity;
            const r = e.rotationRate;
            module._bl_device_motion(
              view.id,
              orNaN(a?.x),
              orNaN(a?.y),
              orNaN(a?.z),
              orNaN(g?.x),
              orNaN(g?.y),
              orNaN(g?.z),
              orNaN(r?.alpha),
              orNaN(r?.beta),
              orNaN(r?.gamma),
              orNaN(e.interval),
            );
          };
    addEventListener(eventName(data.kind), listener);
    listeners.set(`${view.id}:${data.kind}`, listener);
  });
  ctx.on<{ kind: Kind }>('sensor-stop', (data, view) => {
    if (view) stop(view, data.kind);
  });
  ctx.onView((view, signal) =>
    signal.addEventListener('abort', () => {
      stop(view, 'orientation');
      stop(view, 'motion');
    }),
  );
  ctx.signal.addEventListener('abort', () => {
    for (const [key, listener] of listeners)
      removeEventListener(
        eventName(key.endsWith('orientation') ? 'orientation' : 'motion'),
        listener,
      );
    listeners.clear();
  });
}
