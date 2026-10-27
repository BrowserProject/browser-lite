// Compositor thread: composites the layers (LayerTreeHostWasm) with Skia on
// the GPU and shows the frame in the canvas of the view.
//
// Its own pthread with its own WebGL 2 context. Like the engine thread it
// always returns to the JS event loop (otherwise Chrome shows no frame) and
// gets work through Emscripten's proxy queue. The canvases of the views belong
// to its worker (engine-pre.js: Module.blPresenterWorker). That way animations
// and scrolling (ScrollingWasm.h) keep running even when the page's JS blocks
// the engine thread for a long time.
#pragma once

#include <pthread.h>
#include <wtf/Function.h>

namespace BrowserLite::Compositor {

// Early in the engine start (engine thread): creates the thread, which makes its WebGL 2 context
// (190 ms with SwiftShader) while the start goes on.
void begin();
// Later in the start: waits for that context. false = no compositor thread (then the engine
// worker shows the frames).
bool start();

bool isRunning();
bool isCompositorThread();
pthread_t thread();

// Thread whose worker has the canvases of the views
pthread_t presenterThread();

// Work on the compositor thread (from any thread)
void dispatch(Function<void()>&&);

// The compositor's WebGL context is lost (new views paint without layers)
// until the browser restores it (GpuRaster.cpp)
bool isLost();
void setLost(bool);

} // namespace BrowserLite::Compositor
