import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserLiteError, checkSupport, createBrowser, defaultServices } from '../dist/index.js';
import { zoomStep } from '../dist/input.js';
import { MemoryPermissionStore, storePermission } from '../dist/permissions.js';

test('checkSupport outside a browser', () => {
  const report = checkSupport();
  assert.equal(report.supported, false);
  assert.ok(report.missing.includes('document'));
});

test('createBrowser outside a browser', async () => {
  await assert.rejects(
    createBrowser({ engineUrl: '/engine/', transport: new EventTarget() }),
    (error) => error instanceof BrowserLiteError && error.code === 'unsupported',
  );
});

test('BrowserLiteError', () => {
  const error = new BrowserLiteError('unsupported', 'missing things', { missing: ['a'] });
  assert.ok(error instanceof Error);
  assert.equal(error.name, 'BrowserLiteError');
  assert.equal(error.code, 'unsupported');
  assert.deepEqual(error.missing, ['a']);
});

test('default services', () => {
  assert.deepEqual(
    defaultServices().map((service) => service.name),
    ['audio', 'media', 'capture', 'devices'],
  );
});

test('memory permission store', () => {
  const store = new MemoryPermissionStore();
  store.set('https://a.example', 'geolocation', 'grant');
  store.set('https://b.example', 'camera', 'deny');
  store.set('https://a.example', 'geolocation', 'deny');
  store.set('https://c.example', 'notifications', 'grant');
  store.set('https://c.example', 'notifications', null);
  assert.deepEqual(
    [...store.entries()],
    [
      ['https://a.example', 'geolocation', 'deny'],
      ['https://b.example', 'camera', 'deny'],
    ],
  );
});

test('camera and microphone together are stored per kind', () => {
  const store = new MemoryPermissionStore();
  storePermission(store, 'https://a.example', 'camera-microphone', 'grant');
  assert.deepEqual(
    [...store.entries()],
    [
      ['https://a.example', 'camera', 'grant'],
      ['https://a.example', 'microphone', 'grant'],
    ],
  );
  storePermission(store, 'https://a.example', 'camera-microphone', null);
  assert.deepEqual([...store.entries()], []);
  // A failing store only warns
  const warn = console.warn;
  console.warn = () => {};
  try {
    storePermission(
      {
        set() {
          throw new Error('full');
        },
        entries: () => [],
      },
      'https://a.example',
      'camera',
      'deny',
    );
  } finally {
    console.warn = warn;
  }
});

test('zoom steps like Chrome', () => {
  assert.equal(zoomStep(1, 1), 1.1);
  assert.equal(zoomStep(1, -1), 0.9);
  assert.equal(zoomStep(1.05, 1), 1.1);
  assert.equal(zoomStep(5, 1), 5);
  assert.equal(zoomStep(0.25, -1), 0.25);
});
