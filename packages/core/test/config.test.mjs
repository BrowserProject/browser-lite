import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { CORE_ENV, engineEnv, preferenceFlags, resolveConfig } from '../dist/config.js';
import { audio, BrowserLiteError, devices, media, webrtc } from '../dist/index.js';

const abi = JSON.parse(readFileSync(new URL('../../../engine/abi.json', import.meta.url), 'utf8'));
const PAGE = 'https://site.example/app/index.html';
const transport = Object.assign(new EventTarget(), { connected: true, openTCP() {} });
const base = { engineUrl: '/engine', transport };
const code = (fn) => {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof BrowserLiteError);
    return error.code;
  }
  return 'no error';
};

test('defaults', () => {
  const config = resolveConfig(base, PAGE);
  assert.equal(config.engineBase, 'https://site.example/engine/');
  assert.equal(config.namespace, 'browserlite');
  assert.equal(config.persistent, true);
  assert.equal(config.colorScheme, 'system');
  assert.equal(config.device, null);
  assert.deepEqual(config.preferences, {
    javascript: true,
    images: true,
    globalPrivacyControl: false,
  });
  assert.equal(config.debug, false);
  assert.equal(config.httpCache, true);
  assert.deepEqual(
    config.services.map((service) => service.name),
    ['audio', 'media', 'capture', 'devices'],
  );
  assert.ok(config.languages.length > 0);
  assert.equal(typeof config.timeZone, 'string');
});

test('engine folder must be same-origin and gets a trailing slash', () => {
  assert.equal(
    resolveConfig({ ...base, engineUrl: 'engine/v1?x=1' }, PAGE).engineBase,
    'https://site.example/app/engine/v1/',
  );
  assert.equal(
    code(() => resolveConfig({ ...base, engineUrl: 'https://cdn.example/engine/' }, PAGE)),
    'invalid-options',
  );
});

test('invalid options', () => {
  const bad = [
    { ...base, transport: {} },
    { ...base, transport: Object.assign(new EventTarget(), { openTCP() {} }) },
    { ...base, storage: { namespace: 'Bad-Name' } },
    { ...base, storage: { namespace: 'x'.repeat(33) } },
    { ...base, storage: { persistent: 'yes' } },
    { ...base, services: [{ name: 'audio' }] },
    { ...base, services: [audio(), audio()] },
    { ...base, handlers: { popup() {} } },
    { ...base, device: { width: 0, height: 100, pixelRatio: 1 } },
    { ...base, languages: [] },
    { ...base, timeZone: 'Mars/Olympus' },
    { ...base, colorScheme: 'blue' },
    { ...base, engine: { env: { BL_FEATURES: 'audio' } } },
    { ...base, engine: { env: { PATH: '/bin' } } },
    { ...base, engine: { env: { BL_X: 1 } } },
    { ...base, engine: { extraCA: 'not pem' } },
    { ...base, engine: { safepointGC: 'sometimes' } },
    { ...base, permissions: {} },
  ];
  for (const options of bad)
    assert.equal(
      code(() => resolveConfig(options, PAGE)),
      'invalid-options',
      JSON.stringify(options),
    );
  assert.equal(
    code(() => devices({ wifi: true })),
    'invalid-options',
  );
});

test('engine environment', () => {
  const config = resolveConfig(
    {
      ...base,
      storage: { namespace: 'site_1' },
      errorPage: '<p>{{message}}</p>',
      timeZone: 'Europe/Zurich',
      keepSessionCookies: true,
      debug: true,
      engine: {
        gpu: false,
        compositing: true,
        safepointGC: 'debug',
        scriptTimeoutSeconds: 5,
        extraCA: '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n',
        log: true,
        env: { JSC_useJIT: '0', BL_MEMORY_PRESSURE_MB: '512' },
      },
    },
    PAGE,
  );
  const env = engineEnv(config, ['audio', 'media'], true);
  assert.deepEqual(env, {
    JSC_useJIT: '0',
    BL_MEMORY_PRESSURE_MB: '512',
    BL_FEATURES: 'audio,media',
    BL_STORAGE_NAMESPACE: 'site_1',
    TZ: 'Europe/Zurich',
    BL_ERROR_PAGE: '<p>{{message}}</p>',
    BL_TEST_HOOKS: '1',
    BL_DEBUG: '1',
    BL_GPU: '0',
    BL_COMPOSITING: '1',
    BL_SAFEPOINT_GC: 'debug',
    BL_SCRIPT_TIMEOUT: '5',
    BL_EXTRA_CA: '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n',
    BL_KEEP_SESSION_COOKIES: '1',
  });
  const plain = engineEnv(resolveConfig(base, PAGE), [], true);
  assert.deepEqual(plain, {
    BL_FEATURES: '',
    BL_STORAGE_NAMESPACE: 'browserlite',
    TZ: plain.TZ,
  });
  for (const key of Object.keys(env))
    if (key.startsWith('BL_') && !key.startsWith('BL_MEMORY'))
      assert.ok(CORE_ENV.includes(key), key);
});

test('storage and HTTP cache switches', () => {
  const memory = engineEnv(resolveConfig(base, PAGE), ['audio'], false);
  assert.equal(memory.BL_OPFS, '0');
  assert.equal(memory.BL_HTTP_CACHE, '0');
  assert.equal(memory.BL_BYTECODE_CACHE, '0');
  const noCache = engineEnv(
    resolveConfig({ ...base, engine: { httpCache: false } }, PAGE),
    [],
    true,
  );
  assert.equal(noCache.BL_HTTP_CACHE, '0');
  assert.equal(noCache.BL_OPFS, undefined);
  assert.equal(noCache.BL_BYTECODE_CACHE, undefined);
});

test('core-owned switches match engine/abi.json', () => {
  const owned = abi.env
    .filter((entry) => entry.class === 'core-owned' || entry.class === 'debug-only')
    .map((entry) => entry.name);
  assert.deepEqual([...CORE_ENV].sort(), owned.sort());
  for (const key of CORE_ENV)
    assert.equal(
      code(() => resolveConfig({ ...base, engine: { env: { [key]: '1' } } }, PAGE)),
      'invalid-options',
      key,
    );
  const names = new Set(abi.env.map((entry) => entry.name));
  const config = resolveConfig(
    {
      ...base,
      errorPage: '<p></p>',
      keepSessionCookies: true,
      debug: true,
      engine: {
        gpu: true,
        compositing: true,
        safepointGC: true,
        httpCache: false,
        scriptTimeoutSeconds: 1,
        extraCA: '-----BEGIN CERTIFICATE-----\n-----END CERTIFICATE-----\n',
        log: true,
      },
    },
    PAGE,
  );
  for (const key of Object.keys(engineEnv(config, ['audio'], false)))
    assert.ok(names.has(key), `${key} is not in engine/abi.json`);
});

test('features of the services', () => {
  assert.deepEqual(audio().features, ['audio']);
  assert.deepEqual(media().features, ['media', 'pip']);
  assert.deepEqual(media({ pictureInPicture: false }).features, ['media']);
  assert.deepEqual(webrtc().features, ['webrtc']);
  assert.deepEqual(devices().features, [
    'geolocation',
    'sensors',
    'gamepad',
    'speech',
    'notifications',
    'fs-access',
    'clipboard',
    'eyedropper',
    'battery',
    'keyboard',
    'network-info',
    'image-decoder',
  ]);
  assert.deepEqual(devices({ geolocation: false, clipboard: false, touch: false }).features, [
    'sensors',
    'gamepad',
    'speech',
    'notifications',
    'fs-access',
    'eyedropper',
    'battery',
    'keyboard',
    'network-info',
    'image-decoder',
  ]);
});

test('preference flags', () => {
  assert.equal(preferenceFlags({ javascript: true, images: true, globalPrivacyControl: false }), 0);
  assert.equal(
    preferenceFlags({ javascript: false, images: false, globalPrivacyControl: true }),
    7,
  );
});
