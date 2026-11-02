import { runtime } from './runtime.js';
import { hostScreenSize, startSettings } from './settings.js';

/**
 * Rotating the phone or tablet the demo runs on: when the device of the settings is the host
 * itself (its real screen), the engine's screen follows the orientation, so pages lay out again
 * for landscape or portrait and get `screen.orientation`'s `change` event. An emulated device of
 * another kind keeps its frame.
 */
export function followRotation(): void {
  matchMedia('(orientation: landscape)').addEventListener('change', () => {
    const start = startSettings();
    const device = start.options.device;
    const browser = runtime.browser;
    if (!device || start.frame || !browser) return;
    const size = hostScreenSize();
    if (size.width === device.width && size.height === device.height) return;
    start.options.device = { ...device, ...size };
    browser.setDevice(start.options.device);
  });
}
