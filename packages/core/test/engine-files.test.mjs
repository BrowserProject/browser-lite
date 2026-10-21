// Early loading of the engine files (engine.ts): every file is requested once and at once, before
// the start waits for anything, and Emscripten gets them through instantiateWasm and
// getPreloadedPackage instead of requesting them again.
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadEngineFiles, provideEngineFiles } from '../dist/engine.js';
import { BrowserLiteError } from '../dist/index.js';

// Smallest module: one exported function f
const WASM = new Uint8Array([
  0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 1, 4, 1, 0x60, 0, 0, 3, 2, 1, 0, 7, 5, 1, 1, 0x66, 0, 0, 0x0a, 4,
  1, 2, 0, 0x0b,
]);
const DATA = new Uint8Array([1, 2, 3]);

/** fetch and the script element of engine.js, recording every request. */
function fakeHost({ wasmType = 'application/wasm', status = 200 } = {}) {
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push([String(url), init?.credentials]);
    if (status !== 200) return new Response('', { status });
    return String(url).endsWith('engine.wasm')
      ? new Response(WASM, { headers: { 'Content-Type': wasmType } })
      : new Response(DATA);
  };
  globalThis.document = {
    createElement: () => ({}),
    head: {
      append(script) {
        requests.push([script.src, 'script']);
        globalThis.createBrowserLiteEngine = async (module) => module;
        queueMicrotask(() => script.onload());
      },
    },
  };
  return requests;
}

let site = 0;
const base = () => `https://site.example/engine-${++site}/`;

test('every engine file is requested once, before the start waits', async () => {
  const requests = fakeHost();
  const url = base();
  const files = loadEngineFiles(url);
  assert.deepEqual(requests.map(([name]) => name).sort(), [
    `${url}engine.data`,
    `${url}engine.js`,
    `${url}engine.wasm`,
  ]);
  assert.ok(requests.every(([, mode]) => mode === 'same-origin' || mode === 'script'));
  assert.equal(typeof (await files.factory), 'function');
  assert.ok((await files.wasm) instanceof WebAssembly.Module);
  assert.deepEqual(new Uint8Array(await files.data), DATA);
  assert.equal(requests.length, 3);
});

test('engine.wasm without application/wasm compiles after the download', async () => {
  const requests = fakeHost({ wasmType: 'application/octet-stream' });
  const files = loadEngineFiles(base());
  assert.ok((await files.wasm) instanceof WebAssembly.Module);
  assert.equal(requests.filter(([name]) => name.endsWith('engine.wasm')).length, 1);
});

test('a missing file fails with engine-load-failed', async () => {
  fakeHost({ status: 404 });
  const files = loadEngineFiles(base());
  await assert.rejects(files.data, (error) => error instanceof BrowserLiteError);
  await assert.rejects(files.wasm, (error) => error.code === 'engine-load-failed');
});

test('Emscripten takes the files instead of requesting them', async () => {
  fakeHost();
  const files = loadEngineFiles(base());
  const module = {};
  const failures = [];
  provideEngineFiles(module, files.wasm, await files.data, (error) => failures.push(error));
  assert.deepEqual(new Uint8Array(module.getPreloadedPackage('engine.data', 3)), DATA);
  assert.equal(module.getPreloadedPackage('engine.data', 3), null, 'handed over once');
  const received = await new Promise((resolve) =>
    module.instantiateWasm({}, (instance, compiled) => resolve({ instance, compiled })),
  );
  assert.equal(typeof received.instance.exports.f, 'function');
  assert.equal(received.compiled, await files.wasm, 'the workers get the compiled module');
  assert.deepEqual(failures, []);
});

test('a failed instantiation reaches the start', async () => {
  fakeHost();
  const files = loadEngineFiles(base());
  const module = {};
  const failed = new Promise((resolve) =>
    provideEngineFiles(module, Promise.reject(new Error('broken')), new ArrayBuffer(0), resolve),
  );
  module.instantiateWasm({}, () => assert.fail('no instance'));
  assert.equal((await failed).message, 'broken');
  await files.wasm;
});
