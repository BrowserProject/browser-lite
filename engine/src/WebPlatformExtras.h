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
class JSObject;
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
void hostCallFinished(uint64_t identifier, bool ok, const WTF::String& resultJSON);
// A call to the host that hostCallFinished answers: callback(ok, resultJSON)
// runs as a task of the window. Returns the identifier of the call.
uint64_t addHostCall(JSC::JSGlobalObject&, JSC::JSObject& callback);

// Calls the function expression source in the window with the arguments. Runs
// outside of the page's CSP, exceptions go to the page's console.
void callEngineFunction(JSC::JSGlobalObject&, const WTF::String& source, const JSC::ArgList&);

} // namespace BrowserLite
