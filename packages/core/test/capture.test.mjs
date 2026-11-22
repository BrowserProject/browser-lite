// The host's cameras and microphones as the engine gets them (bl_set_capture_devices) and the
// errors of a host device that does not open (bl_capture_opened).
import assert from 'node:assert/strict';
import test from 'node:test';
import { hostCaptureDevices, openError } from '../dist/services/capture.js';

const device = (kind, deviceId) => ({ kind, deviceId, label: '', groupId: '' });

test('a host without devices has no cameras and microphones', () => {
  assert.deepEqual(hostCaptureDevices([]), { cameras: [], microphones: [] });
});

test('before the host permission one device of a kind without id counts', () => {
  const list = [device('audioinput', ''), device('videoinput', ''), device('audiooutput', '')];
  assert.deepEqual(hostCaptureDevices(list), { cameras: [''], microphones: [''] });
});

test("Chrome's default and communications entries repeat a microphone and do not count", () => {
  const list = [
    device('audioinput', 'default'),
    device('audioinput', 'communications'),
    device('audioinput', 'mic-1'),
    device('audioinput', 'mic-2'),
    device('videoinput', 'front'),
    device('videoinput', 'back'),
    device('audiooutput', 'default'),
  ];
  assert.deepEqual(hostCaptureDevices(list), {
    cameras: ['front', 'back'],
    microphones: ['mic-1', 'mic-2'],
  });
});

test('a host device that does not open: not found, not allowed or not readable', () => {
  assert.equal(openError(new DOMException('', 'NotFoundError')), 1);
  assert.equal(openError({ name: 'OverconstrainedError' }), 1);
  assert.equal(openError(new DOMException('', 'NotAllowedError')), 2);
  assert.equal(openError(new DOMException('', 'SecurityError')), 2);
  assert.equal(openError(new DOMException('', 'NotReadableError')), 3);
  assert.equal(openError(new DOMException('', 'AbortError')), 3);
  assert.equal(openError(new TypeError('x')), 3);
  assert.equal(openError(null), 3);
});
