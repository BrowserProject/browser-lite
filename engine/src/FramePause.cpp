// The script of a cross-site frame pauses while the user needs the engine thread (#589). All views
// and frames share the engine thread, and an anti-bot challenge in a frame (Cloudflare's Turnstile
// on srf.ch) runs single entries of 10 to 30 s here; input and calls to its page waited that long
// and the watchdog stopped the challenge. Chrome runs a cross-site frame in another process (site
// isolation), so its page answers meanwhile.
//
// Here the frame's script pauses at its next safepoint (patch 0149), like a hidden view's
// (HiddenViews.cpp) or a script in WebKit's debugger, while the nested event loop of dialogs does
// the work of the other frames and views. Only a long task pauses, a script that has run for
// 100 ms (scriptRunsLong; the watchdog brings it to a safepoint at the latest then): a short one
// keeps the user waiting no longer than its end, and pausing it froze a frame with a little
// script per animation frame (a game, a map, a player's controls) for as long as the user typed. What pauses is the site's agent: every document of its
// event loop (WebKit keeps one per site, `WindowEventLoop`). A site with a top-level document in
// any view does not pause (input and calls go to the top-level documents), nor does a script with
// frames of another site's script below it. Meanwhile the paused documents run nothing: their
// scheduled tasks and parsers are suspended and their loads deferred, their frames' scripts are
// paused (WebCore runs no event listener and no script of a paused frame, as in the debugger),
// and the rendering update leaves out the steps that run their script (patch 0152).
//
// Input of the user waits for the paused script when it would reach a paused frame (the focus is
// in one, it lands in one or the pointer leaves one): the pause ends, the script goes on and the
// input runs after it, in order with later input of its view, like input to a busy frame in
// Chrome. A paused frame whose document goes away meanwhile (its page navigates, the frame is
// removed) stops its script once it goes on, as Chrome drops the work of a frame it leaves.
#include "config.h"
#include "FramePause.h"

#include "Engine.h"
#include "HiddenViews.h"
#include "WebView.h"

#include <JavaScriptCore/CodeBlock.h>
#include <JavaScriptCore/JSCJSValueInlines.h>
#include <JavaScriptCore/StackVisitor.h>
#include <WebCore/ActiveDOMObject.h>
#include <WebCore/CommonVM.h>
#include <WebCore/Document.h>
#include <WebCore/DocumentParser.h>
#include <WebCore/DocumentInlines.h>
#include <WebCore/DocumentPage.h>
#include <WebCore/DocumentView.h>
#include <WebCore/DoublePoint.h>
#include <WebCore/EventHandler.h>
#include <WebCore/FocusController.h>
#include <WebCore/FrameDestructionObserverInlines.h>
#include <WebCore/FrameLoader.h>
#include <WebCore/FrameTree.h>
#include <WebCore/HitTestResult.h>
#include <WebCore/JSDOMGlobalObject.h>
#include <WebCore/LocalFrame.h>
#include <WebCore/LocalFrameInlines.h>
#include <WebCore/LocalFrameView.h>
#include <WebCore/NodeInlines.h>
#include <WebCore/Page.h>
#include <WebCore/ScriptController.h>
#include <WebCore/ThreadGlobalData.h>
#include <WebCore/WindowEventLoop.h>
#include <wtf/Deque.h>
#include <wtf/HashMap.h>
#include <wtf/HashSet.h>
#include <wtf/MonotonicTime.h>

namespace BrowserLite {

using namespace WebCore;

namespace {

struct PausedFrame {
    Ref<LocalFrame> frame;
    Ref<Document> document;
    // Whether the pause suspended it: a document a hidden view's hold suspended stays with it
    bool suspended;
};

struct PausedAgent {
    Ref<WindowEventLoop> eventLoop;
    Vector<PausedFrame> frames;
    HashSet<int> viewIds;
};

struct HeldInput {
    Function<void(WebView&)> input;
    Function<void()> dropped;
};

} // namespace

static PausedAgent* s_paused;
// Per view: input that waits for a paused frame's script. The entry stays while its input runs,
// so input that comes meanwhile queues behind it.
static HashMap<int, Deque<HeldInput>>& heldInput()
{
    static NeverDestroyed<HashMap<int, Deque<HeldInput>>> held;
    return held;
}
static bool s_heldInputScheduled;

static WindowEventLoop* eventLoopOf(JSC::JSGlobalObject* globalObject)
{
    auto* domGlobalObject = dynamicDowncast<JSDOMGlobalObject>(globalObject);
    RefPtr document = dynamicDowncast<Document>(domGlobalObject ? domGlobalObject->scriptExecutionContext() : nullptr);
    return document ? &document->windowEventLoop() : nullptr;
}

// Whether every frame of the running script belongs to the agent: another site's script below it
// (an event it dispatched to the frame) would run again inside the pause
static bool onlyAgentOnStack(JSC::VM& vm, WindowEventLoop& eventLoop)
{
    bool only = true;
    JSC::StackVisitor::visit(vm.topCallFrame, vm, [&](JSC::StackVisitor& visitor) {
        JSC::JSGlobalObject* globalObject = nullptr;
        if (auto* codeBlock = visitor->codeBlock())
            globalObject = codeBlock->globalObject();
        else if (auto callee = visitor->callee(); callee.isCell()) {
            if (auto* object = dynamicDowncast<JSC::JSObject>(callee.asCell()))
                globalObject = object->structure()->realm();
        }
        if (globalObject && eventLoopOf(globalObject) != &eventLoop) {
            only = false;
            return IterationStatus::Done;
        }
        return IterationStatus::Continue;
    });
    return only;
}

static bool hasHeldInput(const HashSet<int>& viewIds)
{
    for (auto& [id, inputs] : heldInput()) {
        if (!inputs.isEmpty() && viewIds.contains(id))
            return true;
    }
    return false;
}

static void runHeldInput()
{
    s_heldInputScheduled = false;
    // Not inside a pause: the input waits for that script; the pause schedules it again
    if (s_paused)
        return;
    auto& held = heldInput();
    while (!held.isEmpty()) {
        auto entry = held.begin();
        int id = entry->key;
        if (entry->value.isEmpty()) {
            held.remove(entry);
            continue;
        }
        auto item = entry->value.takeFirst();
        RefPtr view = WebView::fromID(id);
        if (!view || view->isBlockedByDialog())
            item.dropped();
        else
            item.input(*view);
        // The input may have paused a frame again, whose loop ran input of other views
        if (auto again = held.find(id); again != held.end() && again->value.isEmpty())
            held.remove(again);
    }
}

// Once the script that kept the input waiting ended (the outermost entry into JS), urgent like
// input: before the next task
static void scheduleHeldInput()
{
    if (s_heldInputScheduled || heldInput().isEmpty())
        return;
    s_heldInputScheduled = true;
    commonVM().whenIdle([] {
        runUrgentOnEngineThread(runHeldInput);
    });
}

bool pauseFrameScriptForUser()
{
    if (s_paused || !scriptRunsLong())
        return false;
    auto& vm = commonVM();
    auto* globalObject = dynamicDowncast<JSDOMGlobalObject>(threadGlobalDataSingleton().currentState());
    RefPtr document = dynamicDowncast<Document>(globalObject ? globalObject->scriptExecutionContext() : nullptr);
    RefPtr page = document ? document->page() : nullptr;
    // Not while the page goes away (unload, pagehide), nor a document a hold already suspended
    if (!page || !page->arePromptsAllowed() || !document->frame() || document->activeDOMObjectsAreSuspended())
        return false;
    Ref eventLoop = document->windowEventLoop();
    PausedAgent agent { eventLoop.copyRef(), { }, { } };
    bool topLevel = false;
    WebView::forEach([&](WebView& view) {
        for (RefPtr<Frame> frame = &view.page().mainFrame(); frame; frame = frame->tree().traverseNext()) {
            RefPtr localFrame = dynamicDowncast<LocalFrame>(*frame);
            RefPtr frameDocument = localFrame ? localFrame->document() : nullptr;
            if (!frameDocument || &frameDocument->windowEventLoop() != eventLoop.ptr())
                continue;
            topLevel = topLevel || localFrame->isMainFrame();
            agent.frames.append({ *localFrame, *frameDocument, !frameDocument->activeDOMObjectsAreSuspended() });
            agent.viewIds.add(view.id());
        }
    });
    if (topLevel || agent.frames.isEmpty() || !onlyAgentOnStack(vm, eventLoop))
        return false;

    for (auto& paused : agent.frames) {
        paused.frame->script().setPaused(true);
        if (!paused.suspended)
            continue;
        // What PageGroupLoadDeferrer does for a page, for one frame. A reason of its own, so a
        // dialog or a hold that ends meanwhile does not resume these documents.
        paused.document->suspendScheduledTasks(ReasonForSuspension::JavaScriptDebuggerPaused);
        if (RefPtr parser = paused.document->parser())
            parser->suspendScheduledTasks();
        paused.frame->loader().setDefersLoading(true);
    }
    auto start = MonotonicTime::now();
    s_paused = &agent;
    // Without a hold only what the user waits for runs meanwhile, during one everything else.
    // Until the last input is a moment ago: the hold of hidden views lasts up to 10 s after
    // typing, a challenge in a frame of the form the user fills in would wait as long. Input that
    // waits for the script ends it once the urgent work is done (a call of the host still runs).
    runNestedEventLoop([&] {
        return (!urgentWorkWaiting() && (hasHeldInput(agent.viewIds) || !userJustWorked())) || !document->frame();
    }, [] {
        return !hiddenViewsWaitForUser();
    });
    s_paused = nullptr;
    bool left = !document->frame();
    for (auto& paused : agent.frames) {
        paused.frame->script().setPaused(false);
        // A document that went away stays as it is
        if (!paused.suspended || !paused.document->frame())
            continue;
        RefPtr framePage = paused.frame->page();
        bool pageWaits = framePage && framePage->defersLoading();
        paused.frame->loader().setDefersLoading(pageWaits);
        if (RefPtr parser = paused.document->parser())
            parser->resumeScheduledTasks();
        paused.document->resumeScheduledTasks(ReasonForSuspension::JavaScriptDebuggerPaused);
        // A hidden view's hold began meanwhile
        if (pageWaits)
            paused.document->suspendScheduledTasks(ReasonForSuspension::WillDeferLoading);
        // The steps a rendering update meanwhile left out
        if (framePage && framePage->lastRenderingUpdateTimestamp() >= start)
            framePage->scheduleRenderingUpdate(allRenderingUpdateSteps);
    }
    debugLog("Frame script of %s paused %.0f ms for the user%s", document->url().host().utf8().data(), (MonotonicTime::now() - start).milliseconds(), left ? ", its document went away: stopped" : "");
    if (left)
        vm.notifyNeedTermination();
    scheduleHeldInput();
    return true;
}

// Whether the point of the view lands in a paused frame
static bool hitsPausedFrame(WebView& view, const DoublePoint& point)
{
    RefPtr frame = view.mainFrame();
    RefPtr frameView = frame ? frame->view() : nullptr;
    if (!frameView)
        return false;
    auto result = frame->eventHandler().hitTestResultAtPoint(LayoutPoint(frameView->windowToContents(flooredIntPoint(point))), { HitTestRequest::Type::ReadOnly, HitTestRequest::Type::AllowChildFrameContent });
    RefPtr node = result.innerNode();
    return node && &node->document().windowEventLoop() == s_paused->eventLoop.ptr();
}

bool inputWaitsForPausedFrame(WebView& view, std::span<const DoublePoint> points)
{
    auto last = view.lastPointerPoint();
    if (!points.empty())
        view.setLastPointerPoint(points.back());
    if (heldInput().contains(view.id()))
        return true;
    if (!s_paused || !s_paused->viewIds.contains(view.id()))
        return false;
    RefPtr focused = view.page().focusController().localFocusedFrame();
    RefPtr focusedDocument = focused ? focused->document() : nullptr;
    if (focusedDocument && &focusedDocument->windowEventLoop() == s_paused->eventLoop.ptr()) {
        debugLog("View %d: the focus is in a paused frame", view.id());
        return true;
    }
    if (points.empty())
        return false;
    // Leaving a paused frame, the pointer's events go to it too
    bool reaches = last && hitsPausedFrame(view, *last);
    for (size_t i = 0; !reaches && i < points.size(); ++i)
        reaches = hitsPausedFrame(view, points[i]);
    if (reaches)
        debugLog("View %d: the pointer is in a paused frame", view.id());
    return reaches;
}

void holdInputForPausedFrame(WebView& view, Function<void(WebView&)>&& input, Function<void()>&& dropped)
{
    if (!heldInput().contains(view.id()))
        debugLog("View %d: input waits for the paused script of a frame", view.id());
    heldInput().ensure(view.id(), [] {
        return Deque<HeldInput> { };
    }).iterator->value.append({ WTF::move(input), WTF::move(dropped) });
    if (!s_paused)
        scheduleHeldInput();
}

} // namespace BrowserLite
