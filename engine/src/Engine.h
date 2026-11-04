// browser-lite engine: shared declarations.
//
// The engine runs entirely on ONE thread (the "engine thread", a web worker
// via Emscripten pthreads). WebCore objects may only be touched there. Calls
// from the host (main thread of the page) get here via runOnEngineThread().
#pragma once

#include <pthread.h>

#include <wtf/Function.h>
#include <wtf/Seconds.h>
#include <wtf/text/WTFString.h>

namespace BrowserLite {

// Engine thread (set in main())
void setEngineThread();
bool isEngineThread();
// pthread of the engine thread, 0 while it is not running
pthread_t engineThread();

// Runs a function on the engine thread (callable from any thread).
// Runs asynchronously as soon as the engine thread is back in the event loop. Calls from the
// host's main thread run in their order before the engine's own waiting work.
void runOnEngineThread(Function<void()>&&);
// Input of the user from the host's main thread, and the compositor's answers that the next
// rendering update waits for (a frame composited or presented): before the engine's own waiting
// work like a call from the host, and the engine thread also takes it in between two of its
// tasks and returns from a long RunLoop pass for it.
void runUrgentOnEngineThread(Function<void()>&&);
// On the engine thread: runs `function` before the other waiting tasks of the engine thread,
// right after the current one.
void runNextOnEngineThread(Function<void()>&&);

// Regular expressions that backtrack a lot run in the host (HostRegExp.cpp, patch 0073)
void installHostRegExp();

// Event loop (EngineLoop.cpp)
void initializeEngineLoop();
void scheduleRunLoopPump();
// Runs work after the current work item and its GC, where the heap is not deferred: a
// synchronous full GC (collectNow) inside a work item only runs at its end (patch 0012)
void runAtTopLevel(Function<void()>&&);
// Zeroes the unused C stack right below the caller, before a work item and a GC (EngineLoop.cpp)
void clearStackBelow();
// Zeroes the C stack from the caller up to its base, right before main unwinds (EngineLoop.cpp)
void clearStackAboveForUnwind();
// Whether the engine thread runs JS in a work item that started at least minimum ago
bool engineThreadInLongScript(WTF::Seconds minimum);
// A page dialog: runs the work of the engine thread nested until done()
// returns true; the views of the dialog's page group hold back (WebView.h)
void runNestedEventLoop(const Function<bool()>& done);

// navigator.permissions.query() (Permissions.cpp)
void installPermissionController();

// Log output, ends up in the console of the host browser
void log(const char* format, ...) WTF_ATTRIBUTE_PRINTF(1, 2);

// Only with BL_DEBUG, with a timestamp in ms
bool debugEnabled();
void debugLog(const char* format, ...) WTF_ATTRIBUTE_PRINTF(1, 2);

} // namespace BrowserLite
