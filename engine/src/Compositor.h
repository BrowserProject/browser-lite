// Compositor-Thread: setzt die Ebenen (LayerTreeHostWasm) mit Skia auf der
// GPU zusammen und zeigt das Bild im Canvas des Tabs.
//
// Ein eigener pthread mit eigenem WebGL-2-Kontext. Er kehrt wie der
// Engine-Thread immer in den JS-Event-Loop zurueck (sonst zeigt Chrome kein
// Bild) und bekommt Arbeit ueber Emscriptens Proxy-Queue. Die Canvas der Tabs
// gehoeren seinem Worker (Oberflaeche: Module.blPresenterWorker). So laufen
// Animationen und Scrollen (ScrollingWasm.h) weiter, auch wenn das JS der
// Seite den Engine-Thread lange blockiert.
#pragma once

#include <pthread.h>
#include <wtf/Function.h>

namespace BrowserLite::Compositor {

// Beim Start der Engine (Engine-Thread): Thread anlegen, WebGL 2 pruefen.
// false = kein Compositor-Thread (dann zeigt der Engine-Worker die Bilder).
bool start();

bool isRunning();
bool isCompositorThread();
pthread_t thread();

// Thread, dessen Worker die Canvas der Tabs hat
pthread_t presenterThread();

// Arbeit auf dem Compositor-Thread (von jedem Thread aus)
void dispatch(Function<void()>&&);

// Der WebGL-Kontext des Compositors ist verloren (neue Views malen ohne
// Ebenen), bis der Browser ihn wiederherstellt (GpuRaster.cpp)
bool isLost();
void setLost(bool);

} // namespace BrowserLite::Compositor
