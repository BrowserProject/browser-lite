// Early loading of the engine files (engine.ts): every file is requested once and at once, before
// the start waits for anything, and Emscripten gets them through instantiateWasm and
// getPreloadedPackage instead of requesting them again.
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDeferredCode, loadEngineFiles, provideEngineFiles } from '../dist/engine.js';
import { BrowserLiteError } from '../dist/index.js';

// Smallest module: one exported function f
const WASM = new Uint8Array([
  0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 1, 4, 1, 0x60, 0, 0, 3, 2, 1, 0, 7, 5, 1, 1, 0x66, 0, 0, 0x0a, 4,
  1, 2, 0, 0x0b,
]);
const DATA = new Uint8Array([1, 2, 3]);

/** fetch and the script element of engine.js, recording every request. */
function fakeHost({ wasmType = 'application/wasm', status = 200, manifest = null } = {}) {
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push([String(url), init?.credentials]);
    if (status !== 200) return new Response('', { status });
    if (String(url).endsWith('manifest.json'))
      return manifest ? Response.json(manifest) : new Response('', { status: 404 });
    return String(url).endsWith('.wasm')
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

test('onProgress counts a download and ends with the start phase', async () => {
  const total = WASM.length + DATA.length;
  const manifest = {
    files: { 'engine.wasm': { size: WASM.length }, 'engine.data': { size: DATA.length } },
  };
  const requests = fakeHost({ manifest });
  const events = [];
  const files = loadEngineFiles(base(), (progress) => events.push(progress));
  await Promise.all([files.wasm, files.data]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(requests.some(([name]) => name.endsWith('manifest.json')));
  assert.deepEqual(events.at(-1), { phase: 'start', loaded: total, total });
  assert.ok(events.slice(0, -1).every((event) => event.phase === 'download'));
});

test('onProgress without a manifest reports an unknown total', async () => {
  fakeHost();
  const events = [];
  const files = loadEngineFiles(base(), (progress) => events.push(progress));
  await Promise.all([files.wasm, files.data]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(events.at(-1).phase, 'start');
  assert.equal(events.at(-1).total, 0);
});

// A split engine.wasm (#238): the smallest module with the custom section bl.deferred, 2 chunks
const SPLIT_WASM = new Uint8Array([
  0,
  0x61,
  0x73,
  0x6d,
  1,
  0,
  0,
  0,
  0,
  13,
  11,
  ...Buffer.from('bl.deferred'),
  0x32,
]);

test('a split engine gets its chunks one after the other once it runs', async () => {
  const requests = fakeHost();
  const url = base();
  const handed = [];
  const running = Promise.resolve({
    blSetDeferred: async (chunk, module) => handed.push([chunk, module]),
  });
  await loadDeferredCode(url, Promise.resolve(new WebAssembly.Module(SPLIT_WASM)), running);
  assert.deepEqual(requests, [
    [`${url}engine.deferred-0.wasm`, 'same-origin'],
    [`${url}engine.deferred-1.wasm`, 'same-origin'],
  ]);
  assert.deepEqual(
    handed.map(([chunk]) => chunk),
    [0, 1],
  );
  assert.ok(handed.every(([, module]) => module instanceof WebAssembly.Module));
});

test('an unsplit engine requests no chunks', async () => {
  const requests = fakeHost();
  const running = Promise.resolve({ blSetDeferred: async () => assert.fail('not split') });
  await loadDeferredCode(base(), Promise.resolve(new WebAssembly.Module(WASM)), running);
  assert.equal(requests.length, 0);
});
