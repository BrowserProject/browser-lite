// Nachrichten von der Engine an die Browser-Oberflaeche (Haupt-Thread der Seite).
#pragma once

#include <span>
#include <wtf/text/WTFString.h>

namespace BrowserLite {

// Ruft im Haupt-Thread Module.onEngineEvent(viewId, type, payload) auf (asynchron).
// payload ist meist JSON. Ohne Host (node-Tests) passiert nichts.
void notifyHost(int viewId, const char* type, const String& payload = { });

// Neues Bild fertig: Pixel (RGBA, premultiplied) liegen im gemeinsamen Speicher.
// Der Host muss mit bl_frame_presented(viewId) bestaetigen, bevor wir weitermalen.
void presentFrameToHost(int viewId, const uint8_t* pixels, int width, int height, int dirtyX, int dirtyY, int dirtyWidth, int dirtyHeight);

// Neues Bild direkt in das Canvas des Tabs, wenn die Oberflaeche es dem
// Engine-Worker gegeben hat (transferControlToOffscreen, engine-pre.js). Laeuft im
// Engine-Thread, der Haupt-Thread kopiert nichts. false: kein Canvas hier, dann
// presentFrameToHost.
bool presentFrameInWorker(int viewId, const uint8_t* pixels, int width, int height, int dirtyX, int dirtyY, int dirtyWidth, int dirtyHeight);
void forgetWorkerCanvas(int viewId);
bool hasWorkerCanvas(int viewId);
// Das Canvas eines Views ist im Worker angekommen (engine-pre.js, bl_canvas_attached)
void workerCanvasArrived(int viewId);
// Mit Compositor-Thread: Bild ohne Ebenen in dessen Worker zeigen. Danach ruft
// er auf dem Engine-Thread WebView::framePresented() und presentIfNeeded() auf.
void presentFrameOnCompositor(int viewId, const uint8_t* pixels, int width, int height, int dirtyX, int dirtyY, int dirtyWidth, int dirtyHeight);

// Host moechte bei der naechsten Gelegenheit (requestAnimationFrame) bl_frame() aufrufen
void requestFrameFromHost(int viewId);

// Daten eines Downloads: ruft im Haupt-Thread Module.onEngineDownloadData(downloadId, bytes)
// auf (bytes ist eine Kopie als Uint8Array).
void sendDownloadData(int downloadId, std::span<const uint8_t>);
// Fertiges PDF zum Drucken: ruft im Haupt-Thread Module.onEnginePrint(viewId, bytes, title)
void sendPrintDocument(int viewId, std::span<const uint8_t>, const String& title);
// Video/Audio (media/): Befehle an das Host-<video> und Daten fuer den Service Worker
void notifyMedia(int playerId, ASCIILiteral type, const String& json, std::span<const uint8_t> = { });
void sendMediaFetch(int fetchId, ASCIILiteral type, const String& json, std::span<const uint8_t> = { });
void sendIconData(int viewId, const String& url, const String& mimeType, std::span<const uint8_t>);

String jsonEscape(const String&);

} // namespace BrowserLite
