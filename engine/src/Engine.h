// browser-lite Engine: gemeinsame Deklarationen.
//
// Die Engine laeuft komplett in EINEM Thread (dem "Engine-Thread", ein Web
// Worker via Emscripten pthreads). Alle WebCore-Objekte duerfen nur dort
// angefasst werden. Aufrufe von der UI (Haupt-Thread der Seite) kommen ueber
// runOnEngineThread() hierher.
#pragma once

#include <pthread.h>

#include <wtf/Function.h>
#include <wtf/text/WTFString.h>

namespace BrowserLite {

// Engine-Thread (wird in main() gesetzt)
void setEngineThread();
bool isEngineThread();
// pthread des Engine-Threads, 0 solange er nicht laeuft
pthread_t engineThread();

// Funktion auf dem Engine-Thread ausfuehren (von jedem Thread aus aufrufbar).
// Laeuft asynchron, sobald der Engine-Thread wieder im Event-Loop ist.
void runOnEngineThread(Function<void()>&&);

// Event-Loop (EngineLoop.cpp)
void initializeEngineLoop();
void scheduleRunLoopPump();
// Nach einem synchronen Warten auf den Nutzer (alert, confirm, prompt): die
// Zeit bis dahin zaehlt nicht fuer den Abbruch blockierender Skripte
void restartScriptWatchdog();

// navigator.permissions.query() (Permissions.cpp)
void installPermissionController();

// Log-Ausgabe, landet in der Konsole des Host-Browsers
void log(const char* format, ...) WTF_ATTRIBUTE_PRINTF(1, 2);

// Nur mit Umgebungsvariable BL_DEBUG (Oberflaeche: ?debug=1), mit Zeitstempel in ms
bool debugEnabled();
void debugLog(const char* format, ...) WTF_ATTRIBUTE_PRINTF(1, 2);

} // namespace BrowserLite
