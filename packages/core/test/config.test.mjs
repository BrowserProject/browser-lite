import assert from 'node:assert/strict';
import test from 'node:test';
import { CORE_ENV, engineEnv, preferenceFlags, resolveConfig } from '../dist/config.js';
import { audio, BrowserLiteError, devices, media, webrtc } from '../dist/index.js';

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
  const plain = engineEnv(resolveConfig(base, PAGE), [], false);
  assert.equal(plain.BL_FEATURES, '');
  assert.equal(plain.BL_OPFS, '0');
  assert.equal(plain.BL_TEST_HOOKS, undefined);
  for (const key of Object.keys(env))
    if (key.startsWith('BL_') && !key.startsWith('BL_MEMORY'))
      assert.ok(CORE_ENV.includes(key), key);
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
