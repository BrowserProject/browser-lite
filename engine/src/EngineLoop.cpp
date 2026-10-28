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
#include <JavaScriptCore/HeapInlines.h>
#include <JavaScriptCore/JSLock.h>
#include <JavaScriptCore/VM.h>
#include <JavaScriptCore/Watchdog.h>
#include <WebCore/CommonVM.h>
#include <WebCore/JSDOMGlobalObject.h>
#include <WebCore/ScriptExecutionContext.h>
#include <WebCore/ThreadGlobalData.h>
#include <WebCore/Timer.h>
#include <wtf/Deque.h>
#include <wtf/MonotonicTime.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/RunLoop.h>
#include <wtf/Vector.h>
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
static Vector<Function<void()>>& topLevelWork()
{
    static NeverDestroyed<Vector<Function<void()>>> work;
    return work;
}

void runAtTopLevel(Function<void()>&& work)
{
    topLevelWork().append(WTF::move(work));
}

template<typename Work>
static void runWithGCAfterwards(Work&& work)
{
    auto* vm = WebCore::commonVMOrNull();
    if (!vm) {
        work();
        for (auto& next : std::exchange(topLevelWork(), { }))
            next();
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
    for (auto& next : std::exchange(topLevelWork(), { }))
        next();
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

// One pass: only what was waiting at the start
static void runLocalTasks()
{
    auto& tasks = localTasks();
    for (size_t count = tasks.size(); count && !tasks.isEmpty(); --count) {
        auto* function = tasks.takeFirst();
        runWithGCAfterwards([&] {
            (*function)();
        });
        delete function;
    }
}

extern "C" EMSCRIPTEN_KEEPALIVE void bl__run_local_tasks()
{
    s_localDrainScheduled = false;
    runLocalTasks();
    if (!localTasks().isEmpty())
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

void runNextOnEngineThread(Function<void()>&& function)
{
    RELEASE_ASSERT(isEngineThread());
    localTasks().prepend(new Function<void()>(WTF::move(function)));
    scheduleLocalDrain();
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

static bool terminateRunawayScript(JSC::JSGlobalObject* entryGlobalObject, void*, void*)
{
    auto message = makeString("Script terminated: it blocked the engine (all views) for "_s, scriptTimeLimit(), " s"_s);
    log("%s", message.utf8().data());
    // The running script, also when it runs nested below a dialog (the VM entry is the dialog's)
    auto* globalObject = WebCore::threadGlobalDataSingleton().currentState();
    if (!globalObject)
        globalObject = entryGlobalObject;
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
static void restartScriptWatchdog()
{
    auto& vm = WebCore::commonVM();
    if (auto* watchdog = vm.watchdog()) {
        JSC::JSLockHolder lock(vm);
        watchdog->setTimeLimit(WTF::Seconds(scriptTimeLimit()), terminateRunawayScript);
    }
}

// From Emscripten (system/lib/pthread/thread_mailbox.c): runs the work other
// threads sent to this one, what the JS event loop does on a notification
extern "C" void _emscripten_check_mailbox();

// A work item of the nested event loop. The script watchdog restarts, so its
// limit applies to each item and not to the dialog's script below. A script
// it stopped leaves a termination request until the outermost VM entry ends,
// cleared here like there (VM::executeEntryScopeServicesOnExit), so the next
// script of another view runs.
template<typename Work>
static void runNestedWork(JSC::VM& vm, Work&& work)
{
    restartScriptWatchdog();
    work();
    JSC::JSLockHolder lock(vm);
    if (vm.hasTerminationRequest() && !vm.traps().hasTrapBit(JSC::VMTraps::NeedTermination))
        vm.clearHasTerminationRequest();
}

// A dialog's page waits until the user answered, the other views go on (#258),
// like WebKitLegacy's modal run loop: WebCore defers the page group of the
// dialog (PageGroupLoadDeferrer), the views of that group hold back input and
// commands (WebView::blockForDialog). The worker's JS event loop does not run
// here, so the loop does its work itself:
// - the mailbox (host calls, curl, compositor), then the local tasks it queued
// - due RunLoop timers (WebCore's timers)
// - otherwise it waits with Atomics.wait on the thread's pthread address,
//   where Emscripten notifies a thread that waits with Atomics.waitAsync
//   (thread_mailbox.c); at most 10 ms, for a notification that came right
//   before the wait or a browser without Atomics.waitAsync (postMessage then)
// Script of other views runs inside the VM entry of the waiting script. Its
// JSExecState starts empty, so microtasks run after each script like in a
// task. When idle the GC may run if the waiting script is the only JS entry on
// the stack (Heap::collectAtSafepoint, patch 0012), like at a safepoint of the
// interpreter: the C++ between that script and here (the dialog's binding and
// Chrome) holds no JS values.
void runNestedEventLoop(const Function<bool()>& done)
{
    RELEASE_ASSERT(isEngineThread());
    auto& vm = WebCore::commonVM();
    auto& threadData = WebCore::threadGlobalDataSingleton();
    auto* scriptState = threadData.currentState();
    threadData.setCurrentState(nullptr);
    // Called from a timer: WebCore's timers may fire again
    WebCore::TimerBase::fireTimersInNestedEventLoop();
    pthread_t self = pthread_self();
    while (!done()) {
        _emscripten_check_mailbox();
        if (!localTasks().isEmpty()) {
            runNestedWork(vm, [] { runLocalTasks(); });
            continue;
        }
        auto next = WTF::RunLoop::nextTimerFireTime();
        auto now = WTF::MonotonicTime::now();
        if (next && *next <= now) {
            runNestedWork(vm, [] { pumpRunLoop(); });
            continue;
        }
        {
            JSC::JSLockHolder lock(vm);
            vm.heap.collectAtSafepoint();
        }
        // Releasing caches is for when no task runs (the dialog's script or
        // navigation is below), the reserve and the pressure report work here too
        checkMemory(ReleaseCaches::No);
        double wait = 10;
        if (next)
            wait = std::min(wait, (*next - now).milliseconds());
        __builtin_wasm_memory_atomic_wait32(reinterpret_cast<int*>(self), static_cast<int>(self), static_cast<int64_t>(wait * 1e6));
    }
    threadData.setCurrentState(scriptState);
    restartScriptWatchdog();
    // What is left runs from the JS event loop again
    if (!localTasks().isEmpty())
        scheduleLocalDrain();
    armTimerForNextScheduledTask();
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
