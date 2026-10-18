import type { ServiceContext } from '../service.js';

interface Effect {
  index: number;
  type: string;
  duration?: number;
  startDelay?: number;
  strongMagnitude?: number;
  weakMagnitude?: number;
}

/** Gamepads: polled once per frame while a page listens (engine Gamepad.cpp). */
export function installGamepad(ctx: ServiceContext): void {
  let monitoring = false;
  let frame = 0;
  const lastState: string[] = [];

  const poll = () => {
    if (!monitoring || frame || ctx.signal.aborted) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (ctx.signal.aborted) return;
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      for (let index = 0; index < Math.max(pads.length, lastState.length); index++) {
        const pad = pads[index];
        const state = pad?.connected
          ? JSON.stringify({
              connected: true,
              id: pad.id,
              mapping: pad.mapping,
              axes: [...pad.axes],
              buttons: pad.buttons.map((button) => button.value),
              haptics: !!pad.vibrationActuator,
            })
          : JSON.stringify({ connected: false });
        if (state !== lastState[index]) {
          lastState[index] = state;
          ctx.module._bl_gamepad(index, ctx.text(state));
        }
      }
      poll();
    });
  };

  ctx.on<{ on?: boolean }>('gamepad-monitor', (data) => {
    monitoring = !!data.on;
    if (monitoring) poll();
  });
  ctx.on<Effect>('gamepad-effect', (data) => {
    const actuator = navigator.getGamepads?.()[data.index]?.vibrationActuator;
    if (!actuator) return;
    if (data.type === 'stop') actuator.reset?.();
    else
      actuator
        .playEffect(data.type as GamepadHapticEffectType, {
          duration: data.duration,
          startDelay: data.startDelay,
          strongMagnitude: data.strongMagnitude,
          weakMagnitude: data.weakMagnitude,
        })
        .catch(() => {});
  });
  addEventListener('gamepadconnected', poll, { signal: ctx.signal });
  ctx.signal.addEventListener('abort', () => cancelAnimationFrame(frame));
}
