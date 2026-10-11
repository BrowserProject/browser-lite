// browser-lite Engine: gemeinsame Deklarationen.
//
// Die Engine laeuft komplett in EINEM Thread (dem "Engine-Thread", ein Web
// Worker via Emscripten pthreads). Alle WebCore-Objekte duerfen nur dort
// angefasst werden. Aufrufe von der UI (Haupt-Thread der Seite) kommen ueber
// runOnEngineThread() hierher.
#pragma once

#include <wtf/Function.h>
#include <wtf/text/WTFString.h>

namespace BrowserLite {

// Engine-Thread (wird in main() gesetzt)
void setEngineThread();
bool isEngineThread();

// Funktion auf dem Engine-Thread ausfuehren (von jedem Thread aus aufrufbar).
// Laeuft asynchron, sobald der Engine-Thread wieder im Event-Loop ist.
void runOnEngineThread(Function<void()>&&);

// Event-Loop (EngineLoop.cpp)
void initializeEngineLoop();
void scheduleRunLoopPump();

// Log-Ausgabe, landet in der Konsole des Host-Browsers
void log(const char* format, ...) WTF_ATTRIBUTE_PRINTF(1, 2);

} // namespace BrowserLite
