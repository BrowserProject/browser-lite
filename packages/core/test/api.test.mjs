import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserLiteError, checkSupport, createBrowser, defaultServices } from '../dist/index.js';
import { zoomStep } from '../dist/input.js';
import { MemoryPermissionStore } from '../dist/permissions.js';

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
  assert.equal(store.get('https://a.example', 'geolocation'), undefined);
  store.set('https://a.example', 'geolocation', 'grant');
  store.set('https://b.example', 'camera', 'deny');
  store.set('https://a.example', 'geolocation', 'deny');
  assert.equal(store.get('https://a.example', 'geolocation'), 'deny');
  assert.deepEqual(
    [...store.entries()],
    [
      ['https://a.example', 'geolocation', 'deny'],
      ['https://b.example', 'camera', 'deny'],
    ],
  );
});

test('zoom steps like Chrome', () => {
  assert.equal(zoomStep(1, 1), 1.1);
  assert.equal(zoomStep(1, -1), 0.9);
  assert.equal(zoomStep(1.05, 1), 1.1);
  assert.equal(zoomStep(5, 1), 5);
  assert.equal(zoomStep(0.25, -1), 0.25);
});
