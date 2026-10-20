// Event loop of the engine.
//
// WebCore uses the generic WTF RunLoop. Normally a thread would block in
// RunLoop::run(). In a web worker that does not work: the worker has to return
// to the JS event loop again and again, otherwise no messages (network, host
// commands) arrive anymore.
//
// So the RunLoop is driven from outside:
// - RunLoop reports "there is work" through the wake-up callback (from any
//   thread) -> we schedule a pump step on the engine thread (coalesced)
// - after every pump step a timer is set for the next due WebCore timer
//   (RunLoop::nextTimerFireTime, patch 0005)

#include "config.h"
#include "Engine.h"
#include "EngineConfig.h"
#include "MemoryWatch.h"

#include <atomic>
#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <emscripten/emscripten.h>
#include <emscripten/proxying.h>
#include <emscripten/threading.h>
#include <pthread.h>
#include <JavaScriptCore/ConsoleTypes.h>
#include <JavaScriptCore/DeferGCInlines.h>
#include <JavaScriptCore/JSLock.h>
#include <JavaScriptCore/VM.h>
#include <JavaScriptCore/Watchdog.h>
#include <WebCore/CommonVM.h>
#include <WebCore/JSDOMGlobalObject.h>
#include <WebCore/ScriptExecutionContext.h>
#include <wtf/Deque.h>
#include <wtf/MonotonicTime.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/RunLoop.h>
#include <wtf/text/MakeString.h>

namespace BrowserLite {

static pthread_t s_engineThread;
static std::atomic<bool> s_engineThreadSet { false };

void setEngineThread()
{
    s_engineThread = pthread_self();
    s_engineThreadSet.store(true, std::memory_order_release);
}

pthread_t engineThread()
{
    return s_engineThreadSet.load(std::memory_order_acquire) ? s_engineThread : 0;
}

bool isEngineThread()
{
    return s_engineThreadSet.load(std::memory_order_acquire) && pthread_equal(pthread_self(), s_engineThread);
}

// Detects input without an answer: after an input the host sends a mark, the
// engine thread stores it here after handling the input. The host reads it
// directly in memory; if it stays behind for long, the engine thread hangs
// (script, C++ loop, lock).
static std::atomic<uint32_t> s_inputMark;
static_assert(std::atomic<uint32_t>::is_always_lock_free);

extern "C" EMSCRIPTEN_KEEPALIVE void bl_input_mark(uint32_t mark)
{
    runOnEngineThread([mark] { s_inputMark.store(mark, std::memory_order_release); });
}

extern "C" EMSCRIPTEN_KEEPALIVE uintptr_t bl_input_mark_address()
{
    return reinterpret_cast<uintptr_t>(&s_inputMark);
}

// All work on the engine thread runs under JSLock and a DeferGC. In
// WebAssembly the conservative GC does not see local variables. So it may only
// run when nothing of JSC/WebCore is on the stack: at the end of the outermost
// DeferGC, so here after the work (patch 0012, Heap.cpp). That way there is no
// need for --spill-pointers, which makes everything about 10x slower.
template<typename Work>
static void runWithGCAfterwards(Work&& work)
{
    auto* vm = WebCore::commonVMOrNull();
    if (!vm) {
        work();
        return;
    }
    JSC::JSLockHolder lock(*vm);
    // Already inside a work item (e.g. the run loop pump from
    // runOnEngineThread): no second DeferGC, the GC at safe points (patch
    // 0012) needs exactly one level
    if (vm->heap.isDeferred()) {
        work();
        return;
    }
    auto gcStart = WTF::MonotonicTime::now();
    // heap.size() is expensive, only for the debug output
    size_t sizeBefore = debugEnabled() ? vm->heap.size() : 0;
    {
        JSC::DeferGC deferGC(*vm);
        work();
        gcStart = WTF::MonotonicTime::now();
    } // a deferred GC runs here
    if (debugEnabled()) {
        auto duration = (WTF::MonotonicTime::now() - gcStart).milliseconds();
        if (duration > 5)
            debugLog("GC %.0f ms, Heap %zu -> %zu kB", duration, sizeBefore / 1024, vm->heap.size() / 1024);
    }
    checkMemory();
}

// Emscripten drains the queue of a thread until it is empty, including what
// arrives meanwhile. With a lot of work (animations, plus every frame from the
// UI thread) the engine worker did not return to the JS event loop for
// seconds. An OffscreenCanvas only shows a new frame when the running JS task
// ends (GitHub stayed white for about 10 s). So everything first goes into an
// own list. One pass only handles what was in it at the start and then yields
// to the event loop through a MessageChannel (without the delay of setTimeout).
static Deque<Function<void()>*>& localTasks()
{
    static NeverDestroyed<Deque<Function<void()>*>> tasks;
    return tasks;
}

static bool s_localDrainScheduled;

EM_JS(void, bl_schedule_local_drain, (), {
    if (!Module.blTaskChannel) {
        Module.blTaskChannel = new MessageChannel();
        Module.blTaskChannel.port2.onmessage = function () { Module._bl__run_local_tasks(); };
    }
    Module.blTaskChannel.port1.postMessage(0);
});

static void scheduleLocalDrain()
{
    if (std::exchange(s_localDrainScheduled, true))
        return;
    bl_schedule_local_drain();
}

extern "C" EMSCRIPTEN_KEEPALIVE void bl__run_local_tasks()
{
    s_localDrainScheduled = false;
    auto& tasks = localTasks();
    for (size_t count = tasks.size(); count && !tasks.isEmpty(); --count) {
        auto* function = tasks.takeFirst();
        runWithGCAfterwards([&] {
            (*function)();
        });
        delete function;
    }
    if (!tasks.isEmpty())
        scheduleLocalDrain();
}

static void runFunction(void* arg)
{
    localTasks().append(static_cast<Function<void()>*>(arg));
    scheduleLocalDrain();
}

void runOnEngineThread(Function<void()>&& function)
{
    RELEASE_ASSERT(s_engineThreadSet.load(std::memory_order_acquire));
    auto* heapFunction = new Function<void()>(WTF::move(function));
    // Also allowed from the engine thread itself: then it runs on the next pass
    // through the JS event loop (like a setTimeout(0), but without throttling).
    if (!emscripten_proxy_async(emscripten_proxy_get_system_queue(), s_engineThread, runFunction, heapFunction)) {
        delete heapFunction;
        log("runOnEngineThread: proxy_async failed");
    }
}

static std::atomic<bool> s_pumpScheduled { false };
static long s_timerId { 0 };
static double s_timerDeadline { 0 };

static void pumpRunLoop();

static void timerFired(void*)
{
    s_timerId = 0;
    s_timerDeadline = 0;
    pumpRunLoop();
}

static void armTimerForNextScheduledTask()
{
    auto next = WTF::RunLoop::nextTimerFireTime();
    if (!next) {
        if (s_timerId) {
            emscripten_clear_timeout(s_timerId);
            s_timerId = 0;
            s_timerDeadline = 0;
        }
        return;
    }
    double deadline = next->secondsSinceEpoch().milliseconds();
    if (s_timerId && s_timerDeadline <= deadline)
        return; // an earlier timer is already running
    if (s_timerId)
        emscripten_clear_timeout(s_timerId);
    double delay = std::max(0.0, deadline - WTF::MonotonicTime::now().secondsSinceEpoch().milliseconds());
    s_timerDeadline = deadline;
    s_timerId = emscripten_set_timeout(timerFired, delay, nullptr);
}

static void pumpRunLoop()
{
    s_pumpScheduled.store(false, std::memory_order_release);
    auto start = WTF::MonotonicTime::now();
    // Run all due timers and waiting tasks once
    runWithGCAfterwards([] {
        WTF::RunLoop::cycle();
    });
    armTimerForNextScheduledTask();
    auto duration = (WTF::MonotonicTime::now() - start).milliseconds();
    if (duration > 50)
        debugLog("RunLoop step took %.0f ms", duration);
}

void scheduleRunLoopPump()
{
    if (s_pumpScheduled.exchange(true, std::memory_order_acq_rel))
        return;
    auto* heapFunction = new Function<void()>([] { pumpRunLoop(); });
    if (!emscripten_proxy_async(emscripten_proxy_get_system_queue(), s_engineThread, runFunction, heapFunction)) {
        delete heapFunction;
        s_pumpScheduled.store(false, std::memory_order_release);
    }
}

// All views share the engine thread, an endless loop in one page stops all of
// them. If an entry into JS (a script, an event handler, a timer) takes longer
// than the limit, the JSC watchdog terminates it, like a terminated worker
// (TerminationException, cannot be caught). The page gets a console message,
// its timers and the other views keep running. Checked at the trap points of
// the interpreter (op_check_traps), the time is measured by a timer in the VM
// traps thread (under Emscripten wall time counts, not CPU time).
// BL_SCRIPT_TIMEOUT: seconds, 0 = off.
static double scriptTimeLimit()
{
    return engineConfig().scriptTimeoutSeconds;
}

static bool terminateRunawayScript(JSC::JSGlobalObject* globalObject, void*, void*)
{
    auto message = makeString("Script terminated: it blocked the engine (all views) for "_s, scriptTimeLimit(), " s"_s);
    log("%s", message.utf8().data());
    if (auto* domGlobalObject = dynamicDowncast<WebCore::JSDOMGlobalObject>(globalObject)) {
        if (RefPtr context = domGlobalObject->scriptExecutionContext())
            context->addConsoleMessage(JSC::MessageSource::JS, JSC::MessageLevel::Error, message);
    }
    return true;
}

static void installScriptWatchdog()
{
    double limit = scriptTimeLimit();
    if (limit <= 0)
        return;
    auto& vm = WebCore::commonVM();
    JSC::JSLockHolder lock(vm);
    vm.ensureWatchdog().setTimeLimit(WTF::Seconds(limit), terminateRunawayScript);
    // Start the timer's thread right away, otherwise the engine thread waits
    // in the first script until a worker is ready for it
    JSC::VMTraps::queue();
}

// In the middle of an entry into JS, setTimeLimit restarts the deadline from now
void restartScriptWatchdog()
{
    auto& vm = WebCore::commonVM();
    if (auto* watchdog = vm.watchdog()) {
        JSC::JSLockHolder lock(vm);
        watchdog->setTimeLimit(WTF::Seconds(scriptTimeLimit()), terminateRunawayScript);
    }
}

void initializeEngineLoop()
{
    RELEASE_ASSERT(isEngineThread());
    installScriptWatchdog();
    // Called while the RunLoop holds its lock, possibly from another thread:
    // only schedule here, never work directly.
    WTF::RunLoop::setWakeUpCallback([] {
        scheduleRunLoopPump();
    });
    scheduleRunLoopPump();
}

bool debugEnabled()
{
    return engineConfig().debug;
}

void debugLog(const char* format, ...)
{
    if (!debugEnabled())
        return;
    va_list args;
    va_start(args, format);
    char buffer[2048];
    vsnprintf(buffer, sizeof(buffer), format, args);
    va_end(args);
    std::fprintf(stderr, "[engine %.0f] %s\n", WTF::MonotonicTime::now().secondsSinceEpoch().milliseconds(), buffer);
}

void log(const char* format, ...)
{
    va_list args;
    va_start(args, format);
    char buffer[2048];
    vsnprintf(buffer, sizeof(buffer), format, args);
    va_end(args);
    std::fprintf(stderr, "[engine] %s\n", buffer);
}

} // namespace BrowserLite
