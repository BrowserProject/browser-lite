// Kleine Teile der Web-Plattform, fuer die WebKit nur Schnittstellen hat und
// der Browser (sonst WebKit2) die Umsetzung liefert:
// - navigator.storage (estimate/persist) ueber einen eigenen StorageProvider
// - screen.orientation ueber einen ScreenOrientationManager
// - Polyfills fuer APIs, die Chromium hat und WebKit (noch) nicht
//   (scheduler.postTask/yield, navigator.vibrate), als User-Script in jedem Frame
#pragma once

#include <wtf/Ref.h>
#include <wtf/UniqueRef.h>

namespace WebCore {
class ScreenOrientationManager;
class StorageProvider;
class UserContentProvider;
}

namespace BrowserLite {

WTF::UniqueRef<WebCore::StorageProvider> createStorageProvider();
WebCore::ScreenOrientationManager& screenOrientationManager();
WTF::Ref<WebCore::UserContentProvider> userContentProvider();

// Bildschirm hat gedreht (bl_set_screen): Beobachter benachrichtigen
void screenOrientationMayHaveChanged();

} // namespace BrowserLite
