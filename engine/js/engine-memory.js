// The engine's WebAssembly memory (--js-library), created before Emscripten's
// initMemory, which takes it from Module.wasmMemory (INCOMING_MODULE_JS_API in
// engine/engine.cmake). A shared memory reserves its whole maximum of address
// space up front, 4 GB here. Where that much is not free, the next smaller
// maximum is tried down to 1 GB: in iOS Safari a page has room for three such
// memories, and the memories of earlier engines of the same process (a page in
// the back-forward cache, an engine not yet collected after a restart) or of
// the pages' WebAssembly take it. A growth beyond the maximum fails like in a
// 32 bit browser, and the engine finds that limit at runtime
// (engine/src/MemoryWatch.cpp).
// A 32 bit browser may also take a 4 GB maximum and silently reserve less (V8
// tries smaller reservations), so only a memory with the full maximum in a 64
// bit address space can grow to it: there BL_MEMORY_RESERVE=0 tells the engine
// that it need not grow ahead to find a limit. A resizable ArrayBuffer of 3 GB
// reserves address space only (nothing is committed) and fails where the
// address space is 32 bit.
addToLibrary({
  blEngineMemory__deps: ['$ENV', 'blAddressSpaceIs64Bit'],
  blEngineMemory__postset: 'if (!ENVIRONMENT_IS_PTHREAD) Module["wasmMemory"] = _blEngineMemory();',
  blEngineMemory: function () {
    var initial = {{{ INITIAL_MEMORY / 65536 }}};
    var full = {{{ MAXIMUM_MEMORY / 65536 }}};
    for (var maximum = full; ; maximum /= 2) {
      try {
        var memory = new WebAssembly.Memory({ initial: initial, maximum: maximum, shared: true });
        if (maximum === full && _blAddressSpaceIs64Bit())
          ENV['BL_MEMORY_RESERVE'] = '0';
        return memory;
      } catch (error) {
        if (!(error instanceof RangeError) || maximum <= 16384)
          throw error;
      }
    }
  },
  blAddressSpaceIs64Bit: function () {
    try {
      var probe = new ArrayBuffer(0, { maxByteLength: 3 * 1024 * 1024 * 1024 });
      return probe.resizable === true && probe.maxByteLength === 3 * 1024 * 1024 * 1024;
    } catch (error) {
      return false;
    }
  },
});
