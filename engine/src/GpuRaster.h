// GPU-Rastern: Skia (Ganesh) malt ueber WebGL 2 des Browsers.
//
// Je ein WebGL-2-Kontext pro Thread, jeder auf einem eigenen OffscreenCanvas:
// der Engine-Thread malt Views ohne Ebenen, der Compositor-Thread (Compositor.h)
// setzt die Ebenen zusammen. Jeder View hat eine Zielflaeche (Textur). Zum
// Anzeigen kommt sie in den Framebuffer des Kontexts und von dort per
// transferToImageBitmap ohne Kopie in das Canvas des Tabs (engine-pre.js).
//
// Unsere WebGL-Bruecke (platform/wasm/angle) wechselt selber GL-Kontexte. Skia
// macht darum vor jedem GL-Aufruf seinen Kontext aktuell (Patch 0020), alles
// andere, was GL braucht, laeuft innerhalb eines Gpu::Scope.
//
// Nach einem Kontextverlust malt der Thread auf der CPU, bis der Browser den
// Kontext wiederherstellt. Dann bekommt Skia einen neuen.
#pragma once

#include <skia/core/SkRefCnt.h>

class GrDirectContext;
class SkSurface;

namespace BrowserLite::Gpu {

// Der Kontext dieses Threads, beim ersten Aufruf angelegt. nullptr ohne WebGL 2,
// nach einem Verlust oder wenn ausgeschaltet (BL_GPU=0, Oberflaeche ?gpu=0).
GrDirectContext* context();

// Macht den GL-Kontext von Skia aktuell und danach den vorherigen wieder
class Scope {
public:
    Scope();
    ~Scope();
    explicit operator bool() const { return m_active; }

private:
    int m_previous { 0 };
    bool m_active { false };
};

// Zielflaeche fuer einen View (Textur, Inhalt bleibt zwischen Bildern erhalten)
sk_sp<SkSurface> createSurface(int width, int height);

// Abschicken und anzeigen: surface in das Canvas des Views. Braucht einen Scope.
// false, wenn der View (noch) kein Canvas im Engine-Worker hat.
bool present(int viewId, SkSurface&);

// Direkt in den Framebuffer des Kontexts malen (Compositor): Flaeche in der
// Groesse des Views, nullptr wenn der View hier kein Canvas hat. Danach
// showFramebuffer() schickt das Bild ohne Kopie ins Canvas des Tabs.
sk_sp<SkSurface> framebufferSurface(int viewId, int width, int height);
bool showFramebuffer(int viewId);

} // namespace BrowserLite::Gpu
