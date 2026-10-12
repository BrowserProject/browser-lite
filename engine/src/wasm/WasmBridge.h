// WebAssembly der Seiten: Bruecke zwischen JSC und der WASM-Engine des Browsers.
//
// JSC kann mit dem C-Loop-Interpreter kein WebAssembly. Die API
// (engine/js/wasm-guest.js) laeuft in JSC und schickt die Arbeit ueber diese
// Bruecke an engine/js/wasm-host.js, das die Module im Browser ausfuehrt.
// Der Speicher der Module liegt im Speicher der Engine, darum kann JSC ihn
// direkt als ArrayBuffer zeigen.
#pragma once

namespace JSC {
class JSGlobalObject;
}

namespace BrowserLite {

// Beim Start: Hook fuer Worker und Worklets setzen
void initializeWebAssembly();

// Legt "WebAssembly" im globalen Objekt an (ausgewertet beim ersten Zugriff)
void installWebAssembly(JSC::JSGlobalObject&);

} // namespace BrowserLite
