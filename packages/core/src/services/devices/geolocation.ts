import { orNaN } from '../../util.js';
import type { ServiceContext } from '../service.js';

/** navigator.geolocation of the pages through the host (engine DeviceClients.cpp). */
export function installGeolocation(ctx: ServiceContext): void {
  const watches = new Map<number, number>();
  const stop = (view: number) => {
    const id = watches.get(view);
    if (id === undefined) return;
    navigator.geolocation?.clearWatch(id);
    watches.delete(view);
  };
  ctx.on<{ highAccuracy?: boolean }>('geolocation-start', (data, view) => {
    if (!view) return;
    stop(view.id);
    const { module } = ctx;
    if (!navigator.geolocation) {
      module._bl_geolocation_error(view.id, 2, ctx.text('No position available'));
      return;
    }
    const id = navigator.geolocation.watchPosition(
      (position) => {
        if (ctx.signal.aborted || view.closed) return;
        const c = position.coords;
        module._bl_geolocation_position(
          view.id,
          c.latitude,
          c.longitude,
          c.accuracy,
          orNaN(c.altitude),
          orNaN(c.altitudeAccuracy),
          orNaN(c.heading),
          orNaN(c.speed),
          position.timestamp,
        );
      },
      (error) => {
        if (!ctx.signal.aborted && !view.closed)
          module._bl_geolocation_error(view.id, error.code, ctx.text(error.message || ''));
      },
      { enableHighAccuracy: !!data.highAccuracy },
    );
    watches.set(view.id, id);
  });
  ctx.on('geolocation-stop', (_data, view) => {
    if (view) stop(view.id);
  });
  ctx.onView((view, signal) => signal.addEventListener('abort', () => stop(view.id)));
  ctx.signal.addEventListener('abort', () => {
    for (const view of [...watches.keys()]) stop(view);
  });
}
