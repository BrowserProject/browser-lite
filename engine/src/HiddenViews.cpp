// Hidden views wait while the user works in a visible one (#364, #394). All views share the engine
// thread, and input only jumps ahead between two tasks (EngineLoop.cpp): a heavy page loading in
// a background tab ran scripts, parser slices and network callbacks of up to seconds each, and
// typing in the front tab lagged by as much (Chrome runs the tab in another process). Hidden
// views without sound wait like the pages below a dialog (setPageWaits) and go on where they
// stopped when the user no longer needs the engine thread:
// - input to a visible view: until no input came for quietTime. Input is what goes through
//   withInput (Exports.cpp): keys, text, clicks, touches, drags; hovering and wheel scrolling on
//   the scrolling thread are not.
// - typing: while the focus of a visible view stays in a text field, until no key or text came
//   for typingQuietTime. A task that runs when a key comes still finishes first, so the pauses
//   of a writer (more than a second between two words or sentences) must not let hidden views
//   start one.
// - a visible view loads a new page: until its load event (at most navigationWait), then
//   quietTime. Until the commit only was not enough: a script of a hidden view that ran on
//   then kept the new page from parsing, loading its images and painting, up to the watchdog's
//   limit (the front tab of Chrome loads in a process of its own). A navigation of the host
//   (withNavigation in Exports.cpp) counts as input as soon as the running task ends.
// - a view becomes visible (a switch of tabs, bl_set_visible): like input from the end of the
//   running task on, and until it made the frame that was due, at most firstFrameWait. A tab that
//   loaded in the background never painted, its first layout and paint come with that frame,
//   and the user looks at an empty page until then; meanwhile hidden tabs (also the one just
//   left) started tasks of seconds between its steps.
// A task of a hidden view that already runs when the user needs the engine thread (an entry into
// JS) pauses at its next safepoint (patch 0149) until the user no longer needs it, like a script
// below a dialog: Firefox interrupts the script of a background tab in the same process to paint
// a tab switch (PaintWhileInterruptingJS), Chrome runs background tabs in other processes. Only
// when no other view shares script with that page: its event loop (the documents of a site) and
// its page group (popups and their opener).
#include "config.h"
#include "HiddenViews.h"

#include "EditorClient.h"
#include "Engine.h"
#include "WebView.h"

#include <WebCore/ActiveDOMObject.h>
#include <WebCore/Document.h>
#include <WebCore/DocumentPage.h>
#include <WebCore/FrameLoader.h>
#include <WebCore/FrameTree.h>
#include <WebCore/JSDOMGlobalObject.h>
#include <WebCore/LocalFrame.h>
#include <WebCore/LocalFrameInlines.h>
#include <WebCore/Page.h>
#include <WebCore/PageGroup.h>
#include <WebCore/ThreadGlobalData.h>
#include <WebCore/WindowEventLoop.h>
#include <wtf/HashSet.h>
#include <wtf/MonotonicTime.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/RunLoop.h>

namespace BrowserLite {

using namespace WebCore;

// Longer than the pause between two keys or taps, short enough that a background tab goes on
// while the user reads
static constexpr Seconds quietTime = 1_s;
// Covers the pauses of someone who writes and thinks; a chat or a form left with the focus in a
// field holds the background tabs no longer than this
static constexpr Seconds typingQuietTime = 10_s;
// A visible page that does not answer does not stop the background tabs for longer
static constexpr Seconds navigationWait = 10_s;
// The first frame of a view just shown, also a page that loaded in the background (its first
// layout and paint), needs no longer than this
static constexpr Seconds firstFrameWait = 5_s;
// How often the holds of the visible views (focus, navigation) are checked while hidden views wait
static constexpr Seconds checkInterval = 250_ms;

static bool s_waiting;
static MonotonicTime s_lastInput = -MonotonicTime::infinity();
// NaN until the first time: no comparison holds
static MonotonicTime s_lastTyping = MonotonicTime::nan();
static MonotonicTime s_navigationStart = MonotonicTime::nan();
static MonotonicTime s_shownAt = MonotonicTime::nan();

static void updateViews()
{
    WebView::forEach([](WebView& view) {
        view.updateWaitForUser();
    });
}

static void quietTimerFired();

static RunLoop::Timer& quietTimer()
{
    static NeverDestroyed<RunLoop::Timer> timer(RunLoop::mainSingleton(), "HiddenViews"_s, quietTimerFired);
    return timer;
}

static void startWaiting(Seconds delay)
{
    if (std::exchange(s_waiting, true))
        return;
    quietTimer().startOneShot(delay);
    debugLog("Hidden views wait for the user");
    updateViews();
}

// From the start of a navigation until the load event of the page it brings
static bool loadsPage(WebView& view)
{
    RefPtr frame = view.mainFrame();
    if (!frame)
        return false;
    if (frame->loader().provisionalDocumentLoader() || frame->loader().policyDocumentLoader())
        return true;
    RefPtr document = frame->document();
    return document && !document->loadEventFinished();
}

// Whether a visible view still needs the engine thread after the quiet time of its last input
static bool visibleViewHolds(MonotonicTime now)
{
    bool typing = now < s_lastTyping + typingQuietTime;
    bool navigation = now < s_navigationStart + navigationWait;
    bool shown = now < s_shownAt + firstFrameWait;
    bool holds = false;
    WebView::forEach([&](WebView& view) {
        if (holds || !view.isVisible() || !view.mainFrame())
            return;
        holds = (navigation && loadsPage(view)) || (typing && takesTextInput(view.page())) || (shown && view.waitsForFrameSinceShown());
    });
    return holds;
}

static void quietTimerFired()
{
    auto now = MonotonicTime::now();
    auto left = s_lastInput + quietTime - now;
    if (left > 0_s) {
        quietTimer().startOneShot(left);
        return;
    }
    if (visibleViewHolds(now)) {
        quietTimer().startOneShot(checkInterval);
        return;
    }
    s_waiting = false;
    debugLog("Hidden views go on");
    updateViews();
}

void userWorksInVisibleView(UserInput input)
{
    s_lastInput = MonotonicTime::now();
    if (input == UserInput::Typing)
        s_lastTyping = s_lastInput;
    startWaiting(quietTime);
}

void visibleViewMayNavigate(WebView& view)
{
    if (!view.isVisible() || !loadsPage(view))
        return;
    s_navigationStart = MonotonicTime::now();
    startWaiting(checkInterval);
}

void visibleViewShown(WebView& view)
{
    if (!view.isVisible())
        return;
    if (view.waitsForFrameSinceShown())
        s_shownAt = MonotonicTime::now();
    userWorksInVisibleView();
    visibleViewMayNavigate(view);
}

bool hiddenViewsWaitForUser()
{
    return s_waiting;
}

bool userJustWorked()
{
    return MonotonicTime::now() < s_lastInput + quietTime;
}

Seconds sinceUserWorked()
{
    return MonotonicTime::now() - s_lastInput;
}

bool userNeedsEngineThread()
{
    return s_waiting || urgentWorkWaiting();
}

template<typename Function>
static void forEachDocument(Page& page, const Function& function)
{
    for (RefPtr<Frame> frame = page.mainFrame(); frame; frame = frame->tree().traverseNext()) {
        if (RefPtr localFrame = dynamicDowncast<LocalFrame>(*frame)) {
            if (RefPtr document = localFrame->document())
                function(*document);
        }
    }
}

// Whether another view shares script with the page: a page of its group or a document in the
// event loop of one of its documents (a script may run for one in the task of another)
static bool sharesScript(Page& page)
{
    HashSet<WindowEventLoop*> eventLoops;
    forEachDocument(page, [&](Document& document) {
        eventLoops.add(&document.windowEventLoop());
    });
    bool shares = false;
    WebView::forEach([&](WebView& view) {
        Ref other = view.page();
        if (shares || other.ptr() == &page)
            return;
        shares = &other->group() == &page.group();
        forEachDocument(other, [&](Document& document) {
            shares = shares || eventLoops.contains(&document.windowEventLoop());
        });
    });
    return shares;
}

bool pauseHiddenScriptForUser()
{
    // The running script, also in an iframe of the page
    auto* globalObject = dynamicDowncast<JSDOMGlobalObject>(threadGlobalDataSingleton().currentState());
    RefPtr document = dynamicDowncast<Document>(globalObject ? globalObject->scriptExecutionContext() : nullptr);
    RefPtr page = document ? document->page() : nullptr;
    // Not while the page goes away (unload, pagehide): no dialog either
    if (!page || !page->arePromptsAllowed())
        return false;
    RefPtr<WebView> paused;
    WebView::forEach([&](WebView& view) {
        if (&view.page() == page.get())
            paused = &view;
    });
    if (!paused || !paused->canPauseScriptForUser() || sharesScript(*page))
        return false;
    paused->pauseScriptForUser();
    return true;
}

void setPageWaits(Page& page, bool waits)
{
    // The order of PageGroupLoadDeferrer: the parser is suspended before loading defers. Style
    // and layout run from timers of their own that the suspension does not cover: a stylesheet
    // or a change of the DOM shortly before made a hidden page recalculate its style and lay
    // itself out in tasks of seconds while the user typed.
    if (waits) {
        forEachDocument(page, [](Document& document) {
            document.suspendScheduledTasks(ReasonForSuspension::WillDeferLoading);
        });
        page.setDefersLoading(true);
        page.setDefersStyleAndLayout(true);
        return;
    }
    page.setDefersStyleAndLayout(false);
    page.setDefersLoading(false);
    // Only suspended documents (resumeScheduledTasks checks the reason): one that came meanwhile
    // (back from the back/forward cache) was never suspended, and resuming twice resumes its
    // objects twice
    forEachDocument(page, [](Document& document) {
        if (document.activeDOMObjectsAreSuspended())
            document.resumeScheduledTasks(ReasonForSuspension::WillDeferLoading);
    });
}

} // namespace BrowserLite
