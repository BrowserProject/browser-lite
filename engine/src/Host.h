// Nachrichten von der Engine an die Browser-Oberflaeche (Haupt-Thread der Seite).
#pragma once

#include <wtf/text/WTFString.h>

namespace BrowserLite {

// Ruft im Haupt-Thread Module.onEngineEvent(viewId, type, payload) auf (asynchron).
// payload ist meist JSON. Ohne Host (node-Tests) passiert nichts.
void notifyHost(int viewId, const char* type, const String& payload = { });

// Neues Bild fertig: Pixel (RGBA, premultiplied) liegen im gemeinsamen Speicher.
// Der Host muss mit bl_frame_presented(viewId) bestaetigen, bevor wir weitermalen.
void presentFrameToHost(int viewId, const uint8_t* pixels, int width, int height, int dirtyX, int dirtyY, int dirtyWidth, int dirtyHeight);

// Host moechte bei der naechsten Gelegenheit (requestAnimationFrame) bl_frame() aufrufen
void requestFrameFromHost(int viewId);

String jsonEscape(const String&);

} // namespace BrowserLite
