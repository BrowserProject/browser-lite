#include "config.h"
#include "ScrollingWasm.h"

#include "Engine.h"
#include "LayerTreeHostWasm.h"
#include "WebView.h"

#if ENABLE(ASYNC_SCROLLING) && ENABLE(SCROLLING_THREAD)
#include <WebCore/ScrollingThread.h>
#include <WebCore/ScrollingTreeCoordinated.h>
#include <wtf/HashMap.h>
#include <wtf/Lock.h>
#include <wtf/NeverDestroyed.h>

namespace BrowserLite {

using namespace WebCore;

namespace {

struct Entry {
    RefPtr<ThreadedScrollingTree> tree;
    bool animatedScroll { false };
    // A wheel event scrolled, the next frame of the compositor has not come yet
    bool wheelScrolled { false };
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
    entries().set(viewId, Entry { WTF::move(tree), false });
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
    tree->willProcessWheelEvent();

    ScrollingThread::dispatch([tree = WTF::move(tree), viewId, event, steps, useEngineThreadForScrolling] {
        if (useEngineThreadForScrolling) {
            // The page has a wheel listener that can prevent scrolling
            tree->willSendEventToMainThread(event);
            sendToEngine(viewId, event, steps);
            tree->waitForEventToBeProcessedByMainThread(event);
            return;
        }

        auto result = tree->handleWheelEvent(event, steps);
        // The scrolling thread applies the new position on the next tick if no
        // rendering update of the engine thread comes until then (it may be
        // busy with the page's JS)
        if (result.wasHandled) {
            tree->didScheduleRenderingUpdate();
            {
                Locker locker { s_lock };
                auto it = entries().find(viewId);
                if (it != entries().end())
                    it->value.wheelScrolled = true;
            }
            requestTick(viewId);
        }
        if (result.needsMainThreadProcessing())
            sendToEngine(viewId, event, result.steps);
    });
}

bool displayDidRefresh(int viewId)
{
    RefPtr<ThreadedScrollingTree> tree;
    bool animatedScroll = false;
    bool wheelScrolled = false;
    {
        Locker locker { s_lock };
        auto it = entries().find(viewId);
        if (it == entries().end())
            return false;
        tree = it->value.tree;
        animatedScroll = it->value.animatedScroll;
        wheelScrolled = std::exchange(it->value.wheelScrolled, false);
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
    return animatedScroll;
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
