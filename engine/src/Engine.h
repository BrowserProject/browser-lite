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
// The compositor's answer that the next rendering update waits for (a frame composited or
// presented): urgent like input, but no work of the user, so the script of a cross-site frame
// does not pause for it (FramePause.h). Without layers every animation frame of a page brings
// one, and the script of Cloudflare's challenge paused for each of them.
void runFrameAnswerOnEngineThread(Function<void()>&&);
// On the engine thread: urgent work waits, also while still in the mailbox
bool urgentWorkWaiting();
// On the engine thread: urgent work other than the compositor's answers waits
bool userWorkWaiting();
// On the engine thread: runs `function` before the other waiting tasks of the engine thread,
// right after the current one.
void runNextOnEngineThread(Function<void()>&&);

// Regular expressions that backtrack a lot run in the host (HostRegExp.cpp, patch 0073)
void installHostRegExp();

// Event loop (EngineLoop.cpp)
void initializeEngineLoop();
void scheduleRunLoopPump();
// Names the running step of the engine thread in the debug log ("RunLoop step took N ms
// (navigation)") if it has no name yet; kind must outlive the step (a string literal)
void nameEngineStep(const char* kind);
// Runs work after the current work item and its GC, where the heap is not deferred: a
// synchronous full GC (collectNow) inside a work item only runs at its end (patch 0012)
void runAtTopLevel(Function<void()>&&);
// Zeroes the unused C stack right below the caller, before a work item and a GC (EngineLoop.cpp)
void clearStackBelow();
// Zeroes the C stack from the caller up to its base, right before main unwinds (EngineLoop.cpp)
void clearStackAboveForUnwind();
// Whether the engine thread runs JS in a work item that started at least minimum ago
bool engineThreadInLongScript(WTF::Seconds minimum);
// On the engine thread: whether the running script (the outermost entry into JS) has run for
// 100 ms or more, a long task; until the entry ends
bool scriptRunsLong();
// Brings the script that runs then to its next safepoint after the delay (patch 0149), where
// urgent work that waits may pause it (EngineLoop.cpp)
void requestSafepointAfter(WTF::Seconds delay);
// A page dialog or a paused script: runs the work of the engine thread nested
// until done() returns true, only the urgent work while onlyUrgent() returns
// true; the views of the waiting page's group hold back (WebView.h)
void runNestedEventLoop(const Function<bool()>& done, const Function<bool()>& onlyUrgent = nullptr);

// navigator.permissions.query() (Permissions.cpp)
void installPermissionController();

// Log output, ends up in the console of the host browser
void log(const char* format, ...) WTF_ATTRIBUTE_PRINTF(1, 2);

// Only with BL_DEBUG, with a timestamp in ms
bool debugEnabled();
void debugLog(const char* format, ...) WTF_ATTRIBUTE_PRINTF(1, 2);

} // namespace BrowserLite
