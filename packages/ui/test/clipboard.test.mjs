import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readHostClipboard } from '../dist/clipboard.js';

const withClipboard = async (clipboard, run) => {
  const before = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard }, configurable: true });
  try {
    await run();
  } finally {
    if (before) Object.defineProperty(globalThis, 'navigator', before);
    else delete globalThis.navigator;
  }
};
const item = (data) => ({
  types: Object.keys(data),
  getType: async (type) => new Blob([data[type]], { type }),
});

test('readHostClipboard: text and HTML through read()', async () => {
  await withClipboard(
    { read: async () => [item({ 'text/plain': 'bold text', 'text/html': '<b>bold</b> text' })] },
    async () =>
      assert.deepEqual(await readHostClipboard(), { text: 'bold text', html: '<b>bold</b> text' }),
  );
  await withClipboard({ read: async () => [item({ 'text/plain': 'plain' })] }, async () =>
    assert.deepEqual(await readHostClipboard(), { text: 'plain' }),
  );
});

test('readHostClipboard: readText() without read(), null when denied or missing', async () => {
  await withClipboard({ readText: async () => 'only text' }, async () =>
    assert.deepEqual(await readHostClipboard(), { text: 'only text' }),
  );
  const denied = async () => {
    throw new DOMException('denied', 'NotAllowedError');
  };
  await withClipboard({ read: denied }, async () => assert.equal(await readHostClipboard(), null));
  await withClipboard({ readText: denied }, async () =>
    assert.equal(await readHostClipboard(), null),
  );
  await withClipboard(undefined, async () => assert.equal(await readHostClipboard(), null));
});
