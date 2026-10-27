// Small parts of the web platform for which WebKit only has interfaces and the
// browser (otherwise WebKit2) provides the implementation:
// - navigator.storage (estimate/persist) through an own StorageProvider
// - screen.orientation through a ScreenOrientationManager
// - polyfills for APIs Chromium has and WebKit does not (yet), installed in
//   every window before the page's scripts (installPageExtensions)
#pragma once

#include <wtf/Ref.h>
#include <wtf/UniqueRef.h>
#include <wtf/text/WTFString.h>

namespace JSC {
class ArgList;
class JSGlobalObject;
}

namespace WebCore {
class ScreenOrientationManager;
class StorageProvider;
}

namespace BrowserLite {

WTF::UniqueRef<WebCore::StorageProvider> createStorageProvider();
WebCore::ScreenOrientationManager& screenOrientationManager();
// WebRTC and picture-in-picture through the host (WebRTCPolyfill.cpp), runs
// before the general polyfill
extern const char* const webrtcPolyfillSource;

// The screen rotated (bl_set_screen): notify observers
void screenOrientationMayHaveChanged();

// New window object: runs the polyfills with a bridge to the host browser
// APIs, only for the enabled features (EngineConfig.h). The bridge is an
// argument of the polyfill functions, never a global: host(name, payload,
// callback) calls the host (answered by hostCallFinished), media(...) connects
// tracks (MediaStreamWasm.cpp) and extendPrototype(className, descriptors)
// adds properties to a DOM prototype once the window creates it.
void installPageExtensions(JSC::JSGlobalObject&, int viewId);
// Compiles the polyfills of installPageExtensions (without a window they stop early): JSC's
// code cache keeps their bytecode for the windows (Prewarm.cpp)
void compilePageExtensions();
void hostCallFinished(uint64_t identifier, bool ok, const WTF::String& resultJSON);

// Calls the function expression source in the window with the arguments. Runs
// outside of the page's CSP, exceptions go to the page's console.
void callEngineFunction(JSC::JSGlobalObject&, const WTF::String& source, const JSC::ArgList&);

} // namespace BrowserLite
