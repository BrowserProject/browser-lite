// Kleine Teile der Web-Plattform, fuer die WebKit nur Schnittstellen hat und
// der Browser (sonst WebKit2) die Umsetzung liefert:
// - navigator.storage (estimate/persist) ueber einen eigenen StorageProvider
// - screen.orientation ueber einen ScreenOrientationManager
// - Polyfills fuer APIs, die Chromium hat und WebKit (noch) nicht
//   (scheduler.postTask/yield, navigator.vibrate, EyeDropper, getBattery,
//   navigator.keyboard), als User-Script in jedem Frame
#pragma once

#include <wtf/Ref.h>
#include <wtf/UniqueRef.h>
#include <wtf/text/WTFString.h>

namespace JSC {
class JSGlobalObject;
}

namespace WebCore {
class ScreenOrientationManager;
class StorageProvider;
class UserContentProvider;
}

namespace BrowserLite {

WTF::UniqueRef<WebCore::StorageProvider> createStorageProvider();
WebCore::ScreenOrientationManager& screenOrientationManager();
WTF::Ref<WebCore::UserContentProvider> userContentProvider();
// WebRTC ueber den Host (WebRTCPolyfill.cpp), laeuft vor dem allgemeinen Polyfill
extern const char* const webrtcPolyfillSource;

// Bildschirm hat gedreht (bl_set_screen): Beobachter benachrichtigen
void screenOrientationMayHaveChanged();

// Bruecke fuer die Polyfills zu APIs des Host-Browsers (EyeDropper, Akku,
// Tastatur): __blHost(name, payload, callback) im window. Die Oberflaeche
// (web/devices.js) fuehrt den Aufruf aus und antwortet mit hostCallFinished.
void installHostBridge(JSC::JSGlobalObject&, int viewId);
void hostCallFinished(uint64_t identifier, bool ok, const WTF::String& resultJSON);

} // namespace BrowserLite
