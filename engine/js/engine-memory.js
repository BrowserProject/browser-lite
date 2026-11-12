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
addToLibrary({
  blEngineMemory__postset: 'if (!ENVIRONMENT_IS_PTHREAD) Module["wasmMemory"] = _blEngineMemory();',
  blEngineMemory: function () {
    var initial = {{{ INITIAL_MEMORY / 65536 }}};
    for (var maximum = {{{ MAXIMUM_MEMORY / 65536 }}}; ; maximum /= 2) {
      try {
        return new WebAssembly.Memory({ initial: initial, maximum: maximum, shared: true });
      } catch (error) {
        if (!(error instanceof RangeError) || maximum <= 16384)
          throw error;
      }
    }
  },
});
