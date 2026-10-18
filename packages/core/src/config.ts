import { BrowserLiteError } from './errors.js';
import { MemoryPermissionStore } from './permissions.js';
import { defaultServices } from './services/index.js';
import { Service } from './services/service.js';
import type {
  BrowserOptions,
  ColorScheme,
  DeviceOptions,
  PermissionStore,
  Preferences,
  RequestHandlers,
  ServiceWorkerOption,
  StorageOptions,
  Transport,
} from './types.js';
import { hostLanguages, hostTimeZone } from './util.js';

const NAMESPACE = /^[a-z0-9_]{1,32}$/;
const EXPERT_ENV = /^(BL|JSC|FC)_[A-Za-z0-9_]+$/;

/** Engine switches the core sets from typed options; `engine.env` must not set them. */
export const CORE_ENV = [
  'BL_FEATURES',
  'BL_STORAGE_NAMESPACE',
  'BL_ERROR_PAGE',
  'BL_TEST_HOOKS',
  'BL_OPFS',
  'BL_EXTRA_CA',
  'BL_KEEP_SESSION_COOKIES',
  'BL_DEBUG',
  'BL_GPU',
  'BL_COMPOSITING',
  'BL_SAFEPOINT_GC',
  'BL_SCRIPT_TIMEOUT',
] as const;

/** Options after validation and defaults; the only input of everything else. */
export interface Config {
  engineBase: string;
  transport: Transport;
  namespace: string;
  persistent: boolean;
  beforeStart: StorageOptions['beforeStart'];
  serviceWorker: ServiceWorkerOption | undefined;
  services: Service[];
  handlers: Partial<RequestHandlers>;
  permissions: PermissionStore;
  errorPage: string | undefined;
  userAgent: string;
  platform: string;
  languages: string[];
  timeZone: string;
  colorScheme: ColorScheme;
  device: Required<DeviceOptions> | null;
  preferences: Required<Preferences>;
  keepSessionCookies: boolean;
  gpu: boolean | undefined;
  compositing: boolean | undefined;
  safepointGC: boolean | 'debug' | undefined;
  httpCache: boolean;
  scriptTimeoutSeconds: number | undefined;
  extraCA: string | undefined;
  log: boolean;
  env: Record<string, string>;
  debug: boolean;
}

function invalid(message: string): never {
  throw new BrowserLiteError('invalid-options', message);
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value !== undefined && typeof value !== 'boolean') invalid(`${name} must be a boolean`);
  return value as boolean | undefined;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value !== undefined && typeof value !== 'string') invalid(`${name} must be a string`);
  return value as string | undefined;
}

/** Folder URL of the engine with a trailing slash; same origin as the page. */
export function engineBase(url: string | URL, base: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url, base);
  } catch {
    return invalid(`engineUrl is no URL: ${String(url)}`);
  }
  if (!parsed.pathname.endsWith('/')) parsed.pathname += '/';
  parsed.search = '';
  parsed.hash = '';
  if (parsed.origin !== new URL(base).origin)
    invalid('engineUrl must be same-origin (the engine starts workers from it)');
  return parsed.href;
}

/** Validates the namespace of the storage (also used by clearStorage). */
export function checkNamespace(namespace: unknown): string {
  if (namespace === undefined) return 'browserlite';
  if (typeof namespace !== 'string' || !NAMESPACE.test(namespace))
    invalid('storage.namespace must match ^[a-z0-9_]{1,32}$');
  return namespace;
}

function device(value: unknown): Required<DeviceOptions> | null {
  if (value === undefined) return null;
  if (!isObject(value)) return invalid('device must be an object');
  for (const key of ['width', 'height', 'pixelRatio'] as const) {
    const number = value[key];
    if (typeof number !== 'number' || !Number.isFinite(number) || number <= 0)
      invalid(`device.${key} must be a positive number`);
  }
  return {
    width: Math.round(value.width as number),
    height: Math.round(value.height as number),
    pixelRatio: value.pixelRatio as number,
    touch: optionalBoolean(value.touch, 'device.touch') ?? true,
    mobile: optionalBoolean(value.mobile, 'device.mobile') ?? true,
  };
}

/** Checks the preferences and fills in the defaults. */
export function preferences(value: unknown): Required<Preferences> {
  if (value !== undefined && !isObject(value)) invalid('preferences must be an object');
  const p = (value ?? {}) as Record<string, unknown>;
  return {
    javascript: optionalBoolean(p.javascript, 'preferences.javascript') ?? true,
    images: optionalBoolean(p.images, 'preferences.images') ?? true,
    globalPrivacyControl:
      optionalBoolean(p.globalPrivacyControl, 'preferences.globalPrivacyControl') ?? false,
  };
}

/** Flags of bl_set_preferences. */
export const preferenceFlags = (p: Required<Preferences>): number =>
  (p.javascript ? 0 : 1) | (p.images ? 0 : 2) | (p.globalPrivacyControl ? 4 : 0);

/** Checks a list of languages (navigator.languages). */
export function languages(value: unknown): string[] {
  if (value === undefined) return hostLanguages();
  if (
    !Array.isArray(value) ||
    !value.length ||
    !value.every((item) => typeof item === 'string' && /^[A-Za-z0-9-]+$/.test(item))
  )
    invalid('languages must be a non-empty list of language tags');
  return value as string[];
}

export function colorScheme(value: unknown): ColorScheme {
  if (value === undefined) return 'system';
  if (value !== 'light' && value !== 'dark' && value !== 'system')
    invalid("colorScheme must be 'light', 'dark' or 'system'");
  return value;
}

function timeZone(value: unknown): string {
  if (value === undefined) return hostTimeZone();
  if (typeof value !== 'string') return invalid('timeZone must be a string');
  try {
    Intl.DateTimeFormat(undefined, { timeZone: value });
  } catch {
    invalid(`Unknown time zone: ${value}`);
  }
  return value;
}

function services(value: unknown): Service[] {
  if (value === undefined) return defaultServices() as Service[];
  if (!Array.isArray(value)) return invalid('services must be a list');
  const names = new Set<string>();
  for (const service of value) {
    if (!(service instanceof Service))
      invalid('services must be created with audio(), media(), capture(), webrtc() or devices()');
    if (names.has(service.name)) invalid(`Service ${service.name} is listed twice`);
    names.add(service.name);
  }
  return value as Service[];
}

function env(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!isObject(value)) return invalid('engine.env must be an object');
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!EXPERT_ENV.test(key)) invalid(`engine.env: ${key} is no BL_, JSC_ or FC_ switch`);
    if ((CORE_ENV as readonly string[]).includes(key))
      invalid(`engine.env: ${key} is set by the core from a typed option`);
    if (typeof entry !== 'string') invalid(`engine.env: ${key} must be a string`);
    result[key] = entry;
  }
  return result;
}

function serviceWorker(value: unknown): ServiceWorkerOption | undefined {
  if (value === undefined) return undefined;
  if (isObject(value) && 'registration' in value) {
    if (
      typeof ServiceWorkerRegistration === 'undefined' ||
      !(value.registration instanceof ServiceWorkerRegistration)
    )
      invalid('serviceWorker.registration must be a ServiceWorkerRegistration');
    return value as ServiceWorkerOption;
  }
  if (isObject(value) && (typeof value.url === 'string' || value.url instanceof URL)) {
    optionalString(value.scope, 'serviceWorker.scope');
    return value as ServiceWorkerOption;
  }
  return invalid('serviceWorker must be { registration } or { url, scope? }');
}

const HANDLERS = [
  'dialog',
  'permission',
  'fileChooser',
  'selectPopup',
  'colorPicker',
  'dateTimePicker',
] as const;

function handlers(value: unknown): Partial<RequestHandlers> {
  if (value === undefined) return {};
  if (!isObject(value)) return invalid('handlers must be an object');
  for (const [key, handler] of Object.entries(value)) {
    if (!(HANDLERS as readonly string[]).includes(key)) invalid(`Unknown handler: ${key}`);
    if (handler !== undefined && typeof handler !== 'function')
      invalid(`handlers.${key} must be a function`);
  }
  return value as Partial<RequestHandlers>;
}

function permissionStore(value: unknown): PermissionStore {
  if (value === undefined) return new MemoryPermissionStore();
  if (
    !isObject(value) ||
    typeof value.get !== 'function' ||
    typeof value.set !== 'function' ||
    typeof value.entries !== 'function'
  )
    invalid('permissions must have get, set and entries');
  return value as unknown as PermissionStore;
}

/** Validates the options of createBrowser and applies the defaults. */
export function resolveConfig(options: BrowserOptions, pageUrl: string): Config {
  if (!isObject(options)) invalid('createBrowser needs an options object');
  const transport = options.transport as unknown;
  if (
    !isObject(transport) ||
    typeof transport.openTCP !== 'function' ||
    typeof transport.addEventListener !== 'function' ||
    typeof transport.connected !== 'boolean'
  )
    invalid('transport must implement Transport (openTCP, connected, EventTarget)');
  const storage = (options.storage ?? {}) as Record<string, unknown>;
  if (!isObject(storage)) invalid('storage must be an object');
  if (storage.beforeStart !== undefined && typeof storage.beforeStart !== 'function')
    invalid('storage.beforeStart must be a function');
  const engine = (options.engine ?? {}) as Record<string, unknown>;
  if (!isObject(engine)) invalid('engine must be an object');
  const safepointGC = engine.safepointGC;
  if (safepointGC !== undefined && typeof safepointGC !== 'boolean' && safepointGC !== 'debug')
    invalid("engine.safepointGC must be a boolean or 'debug'");
  const timeout = engine.scriptTimeoutSeconds;
  if (timeout !== undefined && (typeof timeout !== 'number' || !(timeout >= 0)))
    invalid('engine.scriptTimeoutSeconds must be a number >= 0');
  const extraCA = optionalString(engine.extraCA, 'engine.extraCA');
  if (extraCA !== undefined && !extraCA.includes('-----BEGIN CERTIFICATE-----'))
    invalid('engine.extraCA must hold PEM certificates');
  return {
    engineBase: engineBase(options.engineUrl, pageUrl),
    transport: options.transport,
    namespace: checkNamespace(storage.namespace),
    persistent: optionalBoolean(storage.persistent, 'storage.persistent') ?? true,
    beforeStart: storage.beforeStart as StorageOptions['beforeStart'],
    serviceWorker: serviceWorker(options.serviceWorker),
    services: services(options.services),
    handlers: handlers(options.handlers),
    permissions: permissionStore(options.permissions),
    errorPage: optionalString(options.errorPage, 'errorPage'),
    userAgent: optionalString(options.userAgent, 'userAgent') ?? '',
    platform: optionalString(options.platform, 'platform') ?? '',
    languages: languages(options.languages),
    timeZone: timeZone(options.timeZone),
    colorScheme: colorScheme(options.colorScheme),
    device: device(options.device),
    preferences: preferences(options.preferences),
    keepSessionCookies: optionalBoolean(options.keepSessionCookies, 'keepSessionCookies') ?? false,
    gpu: optionalBoolean(engine.gpu, 'engine.gpu'),
    compositing: optionalBoolean(engine.compositing, 'engine.compositing'),
    safepointGC: safepointGC as Config['safepointGC'],
    httpCache: optionalBoolean(engine.httpCache, 'engine.httpCache') ?? true,
    scriptTimeoutSeconds: timeout as number | undefined,
    extraCA,
    log: optionalBoolean(engine.log, 'engine.log') ?? false,
    env: env(engine.env),
    debug: optionalBoolean(options.debug, 'debug') ?? false,
  };
}

/**
 * Environment of the engine (read once at start, engine/abi.json). The only place that maps
 * options to engine switches.
 */
export function engineEnv(
  config: Config,
  features: readonly string[],
  persistent: boolean,
): Record<string, string> {
  const result: Record<string, string> = {
    ...config.env,
    BL_FEATURES: features.join(','),
    BL_STORAGE_NAMESPACE: config.namespace,
    TZ: config.timeZone,
  };
  if (!persistent) result.BL_OPFS = '0';
  if (config.errorPage !== undefined) result.BL_ERROR_PAGE = config.errorPage;
  if (config.debug) result.BL_TEST_HOOKS = '1';
  if (config.log) result.BL_DEBUG = '1';
  if (config.gpu !== undefined) result.BL_GPU = config.gpu ? '1' : '0';
  if (config.compositing !== undefined) result.BL_COMPOSITING = config.compositing ? '1' : '0';
  if (config.safepointGC !== undefined)
    result.BL_SAFEPOINT_GC =
      config.safepointGC === 'debug' ? 'debug' : config.safepointGC ? '1' : '0';
  if (config.scriptTimeoutSeconds !== undefined)
    result.BL_SCRIPT_TIMEOUT = String(config.scriptTimeoutSeconds);
  if (config.extraCA !== undefined) result.BL_EXTRA_CA = config.extraCA;
  if (config.keepSessionCookies) result.BL_KEEP_SESSION_COOKIES = '1';
  return result;
}
