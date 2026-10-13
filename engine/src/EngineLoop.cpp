// Event-Loop der Engine.
//
// WebCore benutzt den generischen WTF RunLoop. Normalerweise wuerde ein Thread
// in RunLoop::run() blockieren. In einem Web Worker geht das nicht: der Worker
// muss immer wieder in den JS-Event-Loop zurueck, sonst kommen keine
// Nachrichten (Netzwerk, UI-Befehle) mehr an.
//
// Darum treiben wir den RunLoop von aussen:
// - RunLoop meldet "es gibt Arbeit" ueber den WakeUp-Callback (von jedem Thread)
//   -> wir planen einen Pump-Schritt auf dem Engine-Thread ein (zusammengefasst)
// - nach jedem Pump-Schritt stellen wir einen Timer auf den naechsten
//   faelligen WebCore-Timer (RunLoop::nextTimerFireTime, Patch 0005)

#include "config.h"
#include "Engine.h"

#include <atomic>
#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <emscripten/emscripten.h>
#include <emscripten/proxying.h>
#include <emscripten/threading.h>
#include <pthread.h>
#include <JavaScriptCore/DeferGCInlines.h>
#include <JavaScriptCore/JSLock.h>
#include <JavaScriptCore/VM.h>
#include <WebCore/CommonVM.h>
#include <WebCore/MemoryRelease.h>
#include <malloc.h>
#include <wtf/Deque.h>
#include <wtf/MonotonicTime.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/RunLoop.h>

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

// Der WASM-Speicher schrumpft nie. Darum geben wir frei, was WebKit sonst erst
// bei Speicherdruck freigibt (Caches, dekodierte Bilder, Back/Forward-Cache,
// kompilierter Code), sobald malloc mehr Speicher vom System holen musste:
// ab der Schwelle bei jedem Wachstum um 32 MB. So wird zuerst der freie Platz
// wiederverwendet. malloc_footprint() kostet nichts (mallinfo() dagegen laeuft
// ueber den ganzen Heap und kostete auf CNN ca. 25 ms pro Aufruf).
// BL_MEMORY_RELEASE_MB: Schwelle in MB, 0 schaltet es ab.
// Aus dlmalloc von Emscripten, in keinem Header deklariert
extern "C" size_t malloc_footprint(void);

static size_t memoryReleaseThreshold()
{
    static size_t threshold = [] {
        const char* value = getenv("BL_MEMORY_RELEASE_MB");
        return static_cast<size_t>(value ? atoi(value) : 192) << 20;
    }();
    return threshold;
}

static void releaseMemoryIfNeeded()
{
    static size_t footprintAtRelease;
    if (!memoryReleaseThreshold())
        return;
    size_t footprint = malloc_footprint();
    if (footprint < memoryReleaseThreshold() || footprint < footprintAtRelease + (32 << 20))
        return;
    footprintAtRelease = footprint;
    auto start = WTF::MonotonicTime::now();
    size_t usedBefore = debugEnabled() ? mallinfo().uordblks : 0;
    WebCore::releaseMemory(WTF::Critical::Yes, WTF::Synchronous::Yes);
    if (debugEnabled()) {
        debugLog("Speicher freigegeben (malloc-Bereich %zu MB): belegt %zu -> %zu MB in %.0f ms", footprint >> 20,
            usedBefore >> 20, static_cast<size_t>(mallinfo().uordblks) >> 20, (WTF::MonotonicTime::now() - start).milliseconds());
    }
}

// Jede Arbeit auf dem Engine-Thread laeuft unter JSLock und einem DeferGC.
// In WebAssembly sieht der konservative GC keine lokalen Variablen. Darum darf
// er nur laufen, wenn nichts von JSC/WebCore auf dem Stack liegt: am Ende des
// aeussersten DeferGC, also hier nach der Arbeit (Patch 0012, Heap.cpp).
// So braucht es kein --spill-pointers, das alles etwa 10x langsamer macht.
template<typename Work>
static void runWithGCAfterwards(Work&& work)
{
    auto* vm = WebCore::commonVMOrNull();
    if (!vm) {
        work();
        return;
    }
    JSC::JSLockHolder lock(*vm);
    // Schon in einer Arbeit (z.B. der Runloop-Pump aus runOnEngineThread):
    // kein zweites DeferGC, der GC an sicheren Punkten (Patch 0012) braucht
    // genau eine Ebene
    if (vm->heap.isDeferred()) {
        work();
        return;
    }
    auto gcStart = WTF::MonotonicTime::now();
    // heap.size() ist teuer, nur fuer die Debug-Ausgabe
    size_t sizeBefore = debugEnabled() ? vm->heap.size() : 0;
    {
        JSC::DeferGC deferGC(*vm);
        work();
        gcStart = WTF::MonotonicTime::now();
    } // hier laeuft ein aufgeschobener GC
    if (debugEnabled()) {
        auto duration = (WTF::MonotonicTime::now() - gcStart).milliseconds();
        if (duration > 5)
            debugLog("GC %.0f ms, Heap %zu -> %zu kB", duration, sizeBefore / 1024, vm->heap.size() / 1024);
    }
    releaseMemoryIfNeeded();
}

// Emscripten arbeitet die Warteschlange eines Threads ab, bis sie leer ist,
// auch was waehrenddessen dazukommt. Bei viel Arbeit (Animationen, dazu jedes
// Bild vom UI-Thread) kam der Engine-Worker so sekundenlang nicht in den
// JS-Event-Loop zurueck. Ein OffscreenCanvas zeigt ein neues Bild aber erst,
// wenn die laufende JS-Aufgabe endet (GitHub blieb ca. 10 s weiss).
// Darum landet alles zuerst in einer eigenen Liste. Ein Durchgang arbeitet nur
// ab, was beim Start drin war, und gibt dann per MessageChannel (ohne die
// Verzoegerung von setTimeout) an den Event-Loop ab.
static Deque<Function<void()>*>& localTasks()
{
    static NeverDestroyed<Deque<Function<void()>*>> tasks;
    return tasks;
}

static bool s_localDrainScheduled;

EM_JS(void, bl_schedule_local_drain, (), {
    if (!Module.blTaskChannel) {
        Module.blTaskChannel = new MessageChannel();
        Module.blTaskChannel.port2.onmessage = function () { Module._bl_run_local_tasks(); };
    }
    Module.blTaskChannel.port1.postMessage(0);
});

static void scheduleLocalDrain()
{
    if (std::exchange(s_localDrainScheduled, true))
        return;
    bl_schedule_local_drain();
}

extern "C" EMSCRIPTEN_KEEPALIVE void bl_run_local_tasks()
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
    // Auch vom Engine-Thread selber erlaubt: dann laeuft es beim naechsten
    // Durchgang durch den JS-Event-Loop (wie ein setTimeout(0), aber ohne Drosselung).
    if (!emscripten_proxy_async(emscripten_proxy_get_system_queue(), s_engineThread, runFunction, heapFunction)) {
        delete heapFunction;
        log("runOnEngineThread: proxy_async fehlgeschlagen");
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
        return; // ein frueherer Timer laeuft schon
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
    // Einmal alle faelligen Timer und wartenden Aufgaben abarbeiten
    runWithGCAfterwards([] {
        WTF::RunLoop::cycle();
    });
    armTimerForNextScheduledTask();
    auto duration = (WTF::MonotonicTime::now() - start).milliseconds();
    if (duration > 50)
        debugLog("RunLoop-Schritt dauerte %.0f ms", duration);
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

void initializeEngineLoop()
{
    RELEASE_ASSERT(isEngineThread());
    // Wird aufgerufen, waehrend der RunLoop sein Lock haelt, eventuell von
    // einem anderen Thread: hier nur einplanen, nie direkt arbeiten.
    WTF::RunLoop::setWakeUpCallback([] {
        scheduleRunLoopPump();
    });
    scheduleRunLoopPump();
}

bool debugEnabled()
{
    static bool enabled = getenv("BL_DEBUG");
    return enabled;
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
