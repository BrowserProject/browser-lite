import { BrowserLiteError } from '../errors.js';
import { installFileSystemAccess } from './devices/fs-access.js';
import { installGamepad } from './devices/gamepad.js';
import { installGeolocation } from './devices/geolocation.js';
import { installImageDecoder } from './devices/image-decoder.js';
import { installNotifications } from './devices/notifications.js';
import {
  installBattery,
  installEyeDropper,
  installKeyboard,
  installNetworkInfo,
} from './devices/platform.js';
import { installSensors } from './devices/sensors.js';
import { installSpeech, startSpeech } from './devices/speech.js';
import { installTouch } from './devices/touch.js';
import { Service, type ServiceContext } from './service.js';

/** Switches of {@link devices}; all default to true. */
export type DeviceSwitches = Partial<
  Record<
    | 'geolocation'
    | 'sensors'
    | 'gamepad'
    | 'speech'
    | 'notifications'
    | 'fileSystemAccess'
    | 'clipboard'
    | 'eyedropper'
    | 'battery'
    | 'keyboard'
    | 'networkInfo'
    | 'imageDecoder'
    | 'touch',
    boolean
  >
>;

type Part = {
  feature: string | null;
  install?(ctx: ServiceContext): void;
  start?(ctx: ServiceContext): void;
};

const PARTS: Record<keyof DeviceSwitches, Part> = {
  geolocation: { feature: 'geolocation', install: installGeolocation },
  sensors: { feature: 'sensors', install: installSensors },
  gamepad: { feature: 'gamepad', install: installGamepad },
  speech: { feature: 'speech', install: installSpeech, start: startSpeech },
  notifications: { feature: 'notifications', install: installNotifications },
  fileSystemAccess: { feature: 'fs-access', install: installFileSystemAccess },
  // Only the navigator.clipboard API of the pages; copy and cut always reach the host
  clipboard: { feature: 'clipboard' },
  eyedropper: { feature: 'eyedropper', install: installEyeDropper },
  battery: { feature: 'battery', install: installBattery },
  keyboard: { feature: 'keyboard', install: installKeyboard },
  networkInfo: { feature: 'network-info', install: installNetworkInfo },
  imageDecoder: { feature: 'image-decoder', install: installImageDecoder },
  touch: { feature: null, install: installTouch },
};

/** Devices and platform APIs of the host for the pages (engine DeviceClients.cpp and others). */
export class DevicesService extends Service {
  readonly features: readonly string[];
  private readonly parts: Part[];

  constructor(switches: DeviceSwitches = {}) {
    super('devices');
    for (const key of Object.keys(switches))
      if (!(key in PARTS))
        throw new BrowserLiteError('invalid-options', `devices(): unknown switch ${key}`);
    this.parts = (Object.keys(PARTS) as (keyof DeviceSwitches)[])
      .filter((key) => switches[key] !== false)
      .map((key) => PARTS[key]);
    this.features = this.parts.flatMap((part) => (part.feature ? [part.feature] : []));
  }

  setup(ctx: ServiceContext): void {
    for (const part of this.parts) part.install?.(ctx);
  }

  override start(ctx: ServiceContext): void {
    for (const part of this.parts) part.start?.(ctx);
  }
}
