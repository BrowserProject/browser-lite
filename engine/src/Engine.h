// browser-lite engine: shared declarations.
//
// The engine runs entirely on ONE thread (the "engine thread", a web worker
// via Emscripten pthreads). WebCore objects may only be touched there. Calls
// from the host (main thread of the page) get here via runOnEngineThread().
#pragma once

#include <pthread.h>

#include <wtf/Function.h>
#include <wtf/text/WTFString.h>

namespace BrowserLite {

// Engine thread (set in main())
void setEngineThread();
bool isEngineThread();
// pthread of the engine thread, 0 while it is not running
pthread_t engineThread();

// Runs a function on the engine thread (callable from any thread).
// Runs asynchronously as soon as the engine thread is back in the event loop.
void runOnEngineThread(Function<void()>&&);
// On the engine thread: runs `function` before the other waiting tasks of the engine thread,
// right after the current one.
void runNextOnEngineThread(Function<void()>&&);

// After the first paint of a view, from any thread (main.cpp)
void didFirstPaint();

// Event loop (EngineLoop.cpp)
void initializeEngineLoop();
void scheduleRunLoopPump();
// After a synchronous wait for the user (alert, confirm, prompt): the time
// until then does not count for aborting blocking scripts
void restartScriptWatchdog();

// navigator.permissions.query() (Permissions.cpp)
void installPermissionController();

// Log output, ends up in the console of the host browser
void log(const char* format, ...) WTF_ATTRIBUTE_PRINTF(1, 2);

// Only with BL_DEBUG, with a timestamp in ms
bool debugEnabled();
void debugLog(const char* format, ...) WTF_ATTRIBUTE_PRINTF(1, 2);

} // namespace BrowserLite
