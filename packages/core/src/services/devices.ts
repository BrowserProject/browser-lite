import { BrowserLiteError } from '../errors.js';
import { installFileSystemAccess } from './devices/fs-access.js';
import { installGamepad } from './devices/gamepad.js';
import { installGeolocation } from './devices/geolocation.js';
import { installImageDecoder } from './devices/image-decoder.js';
import { installNotifications, type NotificationHandler } from './devices/notifications.js';
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

type Switch =
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
  | 'touch';

/**
 * Options of {@link devices}: every part is on unless set to false. `notifications` also takes
 * a handler that shows the notifications of the pages itself (default: notifications of the
 * host browser).
 */
export type DevicesOptions = Partial<Record<Exclude<Switch, 'notifications'>, boolean>> & {
  notifications?: boolean | NotificationHandler;
};

type Part = {
  feature: string | null;
  install?(ctx: ServiceContext, option: unknown): void;
  start?(ctx: ServiceContext): void;
};

const PARTS: Record<Switch, Part> = {
  geolocation: { feature: 'geolocation', install: installGeolocation },
  sensors: { feature: 'sensors', install: installSensors },
  gamepad: { feature: 'gamepad', install: installGamepad },
  speech: { feature: 'speech', install: installSpeech, start: startSpeech },
  notifications: {
    feature: 'notifications',
    install: (ctx, option) => installNotifications(ctx, option as NotificationHandler | undefined),
  },
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
  private readonly parts: [Part, unknown][];

  constructor(options: DevicesOptions = {}) {
    super('devices');
    if (typeof options !== 'object' || options === null)
      throw new BrowserLiteError('invalid-options', 'devices() needs an options object');
    const values = options as Record<string, unknown>;
    for (const [key, value] of Object.entries(values)) {
      if (!(key in PARTS))
        throw new BrowserLiteError('invalid-options', `devices(): unknown switch ${key}`);
      const handler =
        key === 'notifications' &&
        typeof value === 'object' &&
        value !== null &&
        typeof (value as NotificationHandler).show === 'function';
      if (value !== undefined && typeof value !== 'boolean' && !handler)
        throw new BrowserLiteError(
          'invalid-options',
          key === 'notifications'
            ? 'devices(): notifications must be a boolean or { show(notification) }'
            : `devices(): ${key} must be a boolean`,
        );
    }
    this.parts = (Object.keys(PARTS) as Switch[])
      .filter((key) => values[key] !== false)
      .map((key) => [PARTS[key], typeof values[key] === 'object' ? values[key] : undefined]);
    this.features = this.parts.flatMap(([part]) => (part.feature ? [part.feature] : []));
  }

  setup(ctx: ServiceContext): void {
    for (const [part, option] of this.parts) part.install?.(ctx, option);
  }

  override start(ctx: ServiceContext): void {
    for (const [part] of this.parts) part.start?.(ctx);
  }
}
