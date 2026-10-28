#include "config.h"
#include "ScrollingWasm.h"

#include "Engine.h"
#include "LayerTreeHostWasm.h"
#include "WebView.h"

#if ENABLE(ASYNC_SCROLLING) && ENABLE(SCROLLING_THREAD)
#include <atomic>
#include <WebCore/ScrollingThread.h>
#include <WebCore/ScrollingTreeCoordinated.h>
#include <wtf/HashMap.h>
#include <wtf/Lock.h>
#include <wtf/MonotonicTime.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/ThreadSafeRefCounted.h>
#include <wtf/Vector.h>

namespace BrowserLite {

using namespace WebCore;

namespace {

// Like Safari for a trackpad gesture (ThreadedScrollingTree::waitForEventToBeProcessedByMainThread):
// a wheel event over a listener that may cancel it goes to the engine thread, but when that thread
// is in a long script of the page the scrolling thread scrolls and the page gets the event later
// as not cancelable. The following events of that burst do not wait. Pages with long scripts (ads)
// otherwise scrolled seconds late. The scrolling thread never waits for the engine thread, which
// may wait for it (a commit of the scrolling tree).
constexpr Seconds longTask = 100_ms;
constexpr Seconds nonBlockingBurst = 500_ms;

// Who handles a wheel event over a listener that may cancel it: the engine thread when it gets to
// it, else the scrolling thread once the engine thread is in a long script
class WheelClaim : public ThreadSafeRefCounted<WheelClaim> {
public:
    enum class Owner : uint8_t { None, Engine, ScrollingThread };
    static Ref<WheelClaim> create() { return adoptRef(*new WheelClaim); }

    // Returns whether the caller got it
    bool take(Owner owner)
    {
        auto expected = Owner::None;
        return m_owner.compare_exchange_strong(expected, owner) || expected == owner;
    }
    bool isTaken() const { return m_owner.load() != Owner::None; }

private:
    std::atomic<Owner> m_owner { Owner::None };
};

struct PendingWheel {
    Ref<WheelClaim> claim;
    PlatformWheelEvent event;
};

struct Entry {
    RefPtr<ThreadedScrollingTree> tree;
    bool animatedScroll { false };
    // A wheel event scrolled, the next frame of the compositor has not come yet
    bool wheelScrolled { false };
    // Wheel events over listeners that may cancel them, sent to the engine thread; the
    // compositor's ticks hand them to the scrolling thread when that thread is in a long script
    Vector<PendingWheel> pendingWheels;
    // Until then such wheel events scroll without waiting for the engine thread, which did not
    // take one in time
    MonotonicTime nonBlockingUntil;
};

Lock s_lock;

// Scrolling trees of the views, accessed from engine and compositor thread
HashMap<int, Entry>& entries() WTF_REQUIRES_LOCK(s_lock)
{
    static NeverDestroyed<HashMap<int, Entry>> map;
    return map;
}

// The next tick comes with the next frame of the compositor
void requestTick(int viewId)
{
    if (RefPtr scene = CompositorScene::forView(viewId))
        scene->requestScrollingTick();
}

RefPtr<ThreadedScrollingTree> treeForView(int viewId)
{
    Locker locker { s_lock };
    auto it = entries().find(viewId);
    return it == entries().end() ? nullptr : it->value.tree;
}

// Without a scrolling thread: DOM event and scrolling on the engine thread
void sendToEngine(int viewId, const PlatformWheelEvent& event, OptionSet<WheelEventProcessingSteps> steps)
{
    runOnEngineThread([viewId, event, steps] {
        if (auto* view = WebView::fromID(viewId))
            view->dispatchWheelEvent(event, steps);
    });
}

// On the scrolling thread: the new position shows with the next tick if no rendering update of the
// engine thread comes until then (it may be busy with the page's JS)
WheelEventHandlingResult scrollInScrollingThread(int viewId, ThreadedScrollingTree& tree, const PlatformWheelEvent& event, OptionSet<WheelEventProcessingSteps> steps)
{
    auto result = tree.handleWheelEvent(event, steps);
    if (result.wasHandled) {
        tree.didScheduleRenderingUpdate();
        {
            Locker locker { s_lock };
            auto it = entries().find(viewId);
            if (it != entries().end())
                it->value.wheelScrolled = true;
        }
        requestTick(viewId);
    }
    return result;
}

// A wheel event over a listener that may cancel it (the engine thread scrolls): the engine thread
// takes it when it gets to it, unless the scrolling thread took it over before (displayDidRefresh)
void blockingWheelEvent(int viewId, ThreadedScrollingTree& tree, const PlatformWheelEvent& event, OptionSet<WheelEventProcessingSteps> steps)
{
    auto claim = WheelClaim::create();
    {
        Locker locker { s_lock };
        auto it = entries().find(viewId);
        if (it != entries().end())
            it->value.pendingWheels.append({ claim.copyRef(), event });
    }
    tree.willSendEventToMainThread(event);
    runOnEngineThread([viewId, event, steps, claim = WTF::move(claim)] {
        auto* view = WebView::fromID(viewId);
        if (!view)
            return;
        if (claim->take(WheelClaim::Owner::Engine))
            view->dispatchWheelEvent(event, steps);
        else
            view->dispatchWheelEvent(event, { WheelEventProcessingSteps::NonBlockingDOMEventDispatch });
    });
    requestTick(viewId);
    tree.waitForEventToBeProcessedByMainThread(event);
}

bool inNonBlockingBurst(int viewId)
{
    Locker locker { s_lock };
    auto it = entries().find(viewId);
    return it != entries().end() && MonotonicTime::now() < it->value.nonBlockingUntil;
}

} // namespace

Ref<ScrollingCoordinatorWasm> ScrollingCoordinatorWasm::create(Page& page, int viewId)
{
    return adoptRef(*new ScrollingCoordinatorWasm(page, viewId));
}

ScrollingCoordinatorWasm::ScrollingCoordinatorWasm(Page& page, int viewId)
    : ThreadedScrollingCoordinator(&page)
    , m_viewId(viewId)
{
    Ref tree = ScrollingTreeCoordinated::create(*this);
    setScrollingTree(tree.copyRef());
    Locker locker { s_lock };
    entries().set(viewId, Entry { .tree = WTF::move(tree) });
    debugLog("View %d: scrolling in its own thread", viewId);
}

ScrollingCoordinatorWasm::~ScrollingCoordinatorWasm() = default;

void ScrollingCoordinatorWasm::pageDestroyed()
{
    Scrolling::stopForView(m_viewId);
    ThreadedScrollingCoordinator::pageDestroyed();
}

void ScrollingCoordinatorWasm::didCompletePlatformRenderingUpdate()
{
    if (RefPtr tree = scrollingTree())
        downcast<ScrollingTreeCoordinated>(*tree).didCompletePlatformRenderingUpdate();
}

void ScrollingCoordinatorWasm::hasNodeWithAnimatedScrollChanged(bool hasAnimatedScroll)
{
    {
        Locker locker { s_lock };
        auto it = entries().find(m_viewId);
        if (it != entries().end())
            it->value.animatedScroll = hasAnimatedScroll;
    }
    // Schedules a rendering update, afterwards the compositor drives the animation
    ThreadedScrollingCoordinator::hasNodeWithAnimatedScrollChanged(hasAnimatedScroll);
}

namespace Scrolling {

void stopForView(int viewId)
{
    Locker locker { s_lock };
    entries().remove(viewId);
}

void wheelEvent(int viewId, const PlatformWheelEvent& event)
{
    RefPtr tree = treeForView(viewId);
    if (!tree) {
        sendToEngine(viewId, event, { WheelEventProcessingSteps::SynchronousScrolling, WheelEventProcessingSteps::BlockingDOMEventDispatch });
        return;
    }

    // Like EventDispatcher::internalWheelEvent() in WebKit2
    auto steps = tree->determineWheelEventProcessing(event);
    bool useEngineThreadForScrolling = steps.contains(WheelEventProcessingSteps::SynchronousScrolling);
    // In a burst the engine thread missed: scroll here, the page gets it as not cancelable
    if (useEngineThreadForScrolling && inNonBlockingBurst(viewId)) {
        steps = { WheelEventProcessingSteps::AsyncScrolling, WheelEventProcessingSteps::NonBlockingDOMEventDispatch };
        useEngineThreadForScrolling = false;
    }
    tree->willProcessWheelEvent();

    ScrollingThread::dispatch([tree = WTF::move(tree), viewId, event, steps, useEngineThreadForScrolling] {
        if (useEngineThreadForScrolling) {
            // The page has a wheel listener that can prevent scrolling
            blockingWheelEvent(viewId, *tree, event, steps);
            return;
        }

        auto result = scrollInScrollingThread(viewId, *tree, event, steps);
        if (result.needsMainThreadProcessing())
            sendToEngine(viewId, event, result.steps);
    });
}

bool displayDidRefresh(int viewId)
{
    RefPtr<ThreadedScrollingTree> tree;
    bool animatedScroll = false;
    bool wheelScrolled = false;
    bool wheelsPending = false;
    Vector<PlatformWheelEvent> takenOver;
    {
        Locker locker { s_lock };
        auto it = entries().find(viewId);
        if (it == entries().end())
            return false;
        tree = it->value.tree;
        animatedScroll = it->value.animatedScroll;
        wheelScrolled = std::exchange(it->value.wheelScrolled, false);
        auto& pending = it->value.pendingWheels;
        pending.removeAllMatching([](auto& wheel) { return wheel.claim->isTaken(); });
        if (!pending.isEmpty() && engineThreadInLongScript(longTask)) {
            for (auto& wheel : pending) {
                if (wheel.claim->take(WheelClaim::Owner::ScrollingThread))
                    takenOver.append(wheel.event);
            }
            pending.clear();
            it->value.nonBlockingUntil = MonotonicTime::now() + nonBlockingBurst;
        }
        wheelsPending = !pending.isEmpty();
    }
    if (!takenOver.isEmpty()) {
        ScrollingThread::dispatch([viewId, tree, takenOver = WTF::move(takenOver)] {
            for (auto& event : takenOver)
                scrollInScrollingThread(viewId, *tree, event, { WheelEventProcessingSteps::AsyncScrolling });
        });
    }
    // The tree only takes a refresh within 50 ms of the last wheel event
    // (ScrollingTree::hasRecentActivity). On a slow machine this frame may come
    // later, then the new position would wait for the engine thread, which may
    // be busy with the page's JS.
    if (wheelScrolled)
        tree->willProcessWheelEvent();
    // Scroll animation: apply new positions, even without a rendering update
    if (animatedScroll)
        tree->didScheduleRenderingUpdate();
    tree->displayDidRefresh(tree->displayID());
    // Pending wheel events: the next tick looks again
    return animatedScroll || wheelsPending;
}

bool mayCancelWheelEvent(int viewId, const PlatformWheelEvent& event)
{
    RefPtr tree = treeForView(viewId);
    return !tree || tree->determineWheelEventProcessing(event).contains(WheelEventProcessingSteps::BlockingDOMEventDispatch);
}

} // namespace Scrolling

} // namespace BrowserLite

#else

namespace BrowserLite::Scrolling {

// Without a scrolling thread the engine thread scrolls
void stopForView(int) { }
void wheelEvent(int viewId, const WebCore::PlatformWheelEvent& event)
{
    runOnEngineThread([viewId, event] {
        if (auto* view = WebView::fromID(viewId))
            view->dispatchWheelEvent(event, { WebCore::WheelEventProcessingSteps::SynchronousScrolling, WebCore::WheelEventProcessingSteps::BlockingDOMEventDispatch });
    });
}
bool mayCancelWheelEvent(int, const WebCore::PlatformWheelEvent&) { return true; }
bool displayDidRefresh(int) { return false; }

} // namespace BrowserLite::Scrolling

#endif
