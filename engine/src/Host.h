// Messages from the engine to the host (main thread of the page).
#pragma once

#include <span>
#include <wtf/text/WTFString.h>

namespace BrowserLite {

// Calls Module.onEngineEvent(viewId, type, payload, fromEngineThread) on the main thread (async).
// payload is mostly JSON. Without a host (node tests) nothing happens.
void notifyHost(int viewId, const char* type, const String& payload = { });

// New frame ready: pixels (RGBA, premultiplied) are in shared memory.
// The host must confirm with bl_frame_presented(viewId) before we paint again.
void presentFrameToHost(int viewId, const uint8_t* pixels, int width, int height, int dirtyX, int dirtyY, int dirtyWidth, int dirtyHeight);

// New frame directly into the canvas of the view if the host gave it to the
// engine worker (transferControlToOffscreen, engine-pre.js). Runs on the engine
// thread, the main thread copies nothing. false: no canvas here, then
// presentFrameToHost.
bool presentFrameInWorker(int viewId, const uint8_t* pixels, int width, int height, int dirtyX, int dirtyY, int dirtyWidth, int dirtyHeight);
void forgetWorkerCanvas(int viewId);
bool hasWorkerCanvas(int viewId);
// The canvas of a view arrived in the worker (engine-pre.js, bl__canvas_attached)
void workerCanvasArrived(int viewId);
// With the compositor thread: show a frame without layers in its worker. Then
// it calls WebView::framePresented() and presentIfNeeded() on the engine thread.
void presentFrameOnCompositor(int viewId, const uint8_t* pixels, int width, int height, int dirtyX, int dirtyY, int dirtyWidth, int dirtyHeight);

// The host should call bl_frame() at the next opportunity (requestAnimationFrame)
void requestFrameFromHost(int viewId);

// Download data: calls Module.onEngineDownloadData(downloadId, bytes) on the main thread
// (bytes is a copy as Uint8Array).
void sendDownloadData(int downloadId, std::span<const uint8_t>);
// Finished PDF for printing: calls Module.onEnginePrint(viewId, bytes, title) on the main thread
void sendPrintDocument(int viewId, std::span<const uint8_t>, const String& title);
// Video/audio (media/): commands to the host <video> and data for the service worker
void notifyMedia(int playerId, ASCIILiteral type, const String& json, std::span<const uint8_t> = { });
void sendMediaFetch(int fetchId, ASCIILiteral type, const String& json, std::span<const uint8_t> = { });
void sendIconData(int viewId, const String& url, const String& mimeType, std::span<const uint8_t>);

String jsonEscape(const String&);

} // namespace BrowserLite
