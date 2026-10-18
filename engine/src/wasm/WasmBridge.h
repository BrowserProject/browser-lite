// WebAssembly of the pages: bridge between JSC and the WASM engine of the browser.
//
// JSC cannot run WebAssembly with the C loop interpreter. The API
// (engine/js/wasm-guest.js) runs in JSC and sends the work through this bridge
// to engine/js/wasm-host.js, which runs the modules in the browser. The memory
// of the modules lives in the engine memory, so JSC can show it directly as an
// ArrayBuffer.
#pragma once

namespace JSC {
class JSGlobalObject;
}

namespace BrowserLite {

// At start: set the hook for workers and worklets
void initializeWebAssembly();

// Creates "WebAssembly" in the global object (evaluated on the first access)
void installWebAssembly(JSC::JSGlobalObject&);

} // namespace BrowserLite
