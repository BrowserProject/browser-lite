import { domError } from '../../util.js';
import type { ServiceContext } from '../service.js';

interface Battery {
  charging: boolean;
  chargingTime: number;
  dischargingTime: number;
  level: number;
}

interface HostKeyboard {
  lock?(codes?: string[]): Promise<void>;
  unlock?(): void;
  getLayoutMap?(): Promise<Map<string, string>>;
}

const finite = (value: number) => (Number.isFinite(value) ? value : null);

/** EyeDropper of the host. */
export function installEyeDropper(ctx: ServiceContext): void {
  ctx.hostCall('eyedropper', async () => {
    const EyeDropper = (
      globalThis as { EyeDropper?: new () => { open(): Promise<{ sRGBHex: string }> } }
    ).EyeDropper;
    if (typeof EyeDropper !== 'function')
      throw domError('NotSupportedError', 'EyeDropper not supported');
    const result = await new EyeDropper().open();
    return { sRGBHex: result.sRGBHex };
  });
}

/** navigator.getBattery() of the host; without it a full, charging battery. */
export function installBattery(ctx: ServiceContext): void {
  ctx.hostCall('battery', async () => {
    const getBattery = (navigator as { getBattery?: () => Promise<Battery> }).getBattery;
    if (typeof getBattery !== 'function')
      return { charging: true, chargingTime: 0, dischargingTime: null, level: 1 };
    const battery = await getBattery.call(navigator);
    return {
      charging: battery.charging,
      chargingTime: finite(battery.chargingTime),
      dischargingTime: finite(battery.dischargingTime),
      level: battery.level,
    };
  });
}

/** Keyboard lock and layout map of the host. */
export function installKeyboard(ctx: ServiceContext): void {
  const keyboard = () => (navigator as { keyboard?: HostKeyboard }).keyboard;
  ctx.hostCall<{ keyCodes?: string[] } | null>('keyboard-lock', async (payload) => {
    const host = keyboard();
    if (!host?.lock) throw domError('NotSupportedError', 'Keyboard lock not supported');
    await host.lock(payload?.keyCodes || undefined);
    return null;
  });
  ctx.hostCall('keyboard-unlock', async () => {
    keyboard()?.unlock?.();
    return null;
  });
  ctx.hostCall('keyboard-layout', async () => {
    const host = keyboard();
    if (!host?.getLayoutMap) return [];
    return [...(await host.getLayoutMap()).entries()];
  });
}

/** navigator.connection and navigator.deviceMemory of the host. */
export function installNetworkInfo(ctx: ServiceContext): void {
  ctx.hostCall('network-info', async () => {
    const host = navigator as {
      deviceMemory?: number;
      connection?: {
        effectiveType?: string;
        downlink?: number;
        rtt?: number;
        saveData?: boolean;
        type?: string;
      };
    };
    const connection = host.connection;
    return {
      deviceMemory: host.deviceMemory,
      connection: connection
        ? {
            effectiveType: connection.effectiveType,
            downlink: connection.downlink,
            rtt: connection.rtt,
            saveData: connection.saveData,
            type: connection.type,
          }
        : null,
    };
  });
}

/** Copies of the pages go to the clipboard of the host (with HTML like Chrome). */
export function installClipboard(ctx: ServiceContext): void {
  ctx.on<{ text?: string; html?: string }>('clipboard', (data) => {
    const clipboard = navigator.clipboard;
    if (!clipboard) return;
    const writeText = () => clipboard.writeText(data.text || '').catch(() => {});
    if (data.html && typeof ClipboardItem === 'function') {
      const item = new ClipboardItem({
        'text/plain': new Blob([data.text || ''], { type: 'text/plain' }),
        'text/html': new Blob([data.html], { type: 'text/html' }),
      });
      clipboard.write([item]).catch(writeText);
    } else writeText();
  });
}
