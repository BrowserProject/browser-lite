// GPU-Rastern: Skia (Ganesh) malt ueber WebGL 2 des Browsers.
//
// Alles laeuft im Engine-Thread. Ein gemeinsamer WebGL-2-Kontext auf einem
// eigenen OffscreenCanvas; jeder View hat eine Zielflaeche (Textur) darin. Zum
// Anzeigen kommt die Flaeche in den Framebuffer des Kontexts und von dort per
// transferToImageBitmap ohne Kopie in das Canvas des Tabs (engine-pre.js).
//
// Unsere WebGL-Bruecke (platform/wasm/angle) wechselt selber GL-Kontexte. Skia
// ruft GL nur beim Abschicken auf (flush), darum gilt: Malen geht jederzeit,
// alles was GL braucht nur innerhalb eines Gpu::Scope.
#pragma once

#include <skia/core/SkRefCnt.h>

class GrDirectContext;
class SkSurface;

namespace BrowserLite::Gpu {

// Der gemeinsame Kontext, beim ersten Aufruf angelegt. nullptr ohne WebGL 2
// oder wenn ausgeschaltet (BL_GPU=0, Oberflaeche ?gpu=0).
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

} // namespace BrowserLite::Gpu
