// Scrolling in its own thread (like WPE: ScrollingCoordinatorCoordinated +
// EventDispatcher in WebKit2).
//
// WebCore builds a scrolling tree (ScrollingTreeCoordinated) with the
// scrollable areas and their layers. Wheel events go from the host through the
// compositor thread directly to WebCore's scrolling thread. It moves the layers
// and wakes the compositor. The engine thread only gets the event when the
// page needs it (wheel listeners, non-scrollable areas) and learns the new
// scroll position afterwards. That way the page scrolls smoothly even when
// its JS blocks the engine thread.
#pragma once

#include <WebCore/IntPoint.h>
#include <WebCore/PlatformWheelEvent.h>

#if ENABLE(ASYNC_SCROLLING) && ENABLE(SCROLLING_THREAD)
#include <WebCore/ThreadedScrollingCoordinator.h>
#endif

namespace BrowserLite {

#if ENABLE(ASYNC_SCROLLING) && ENABLE(SCROLLING_THREAD)
class ScrollingCoordinatorWasm final : public WebCore::ThreadedScrollingCoordinator {
public:
    static Ref<ScrollingCoordinatorWasm> create(WebCore::Page&, int viewId);

private:
    ScrollingCoordinatorWasm(WebCore::Page&, int viewId);
    ~ScrollingCoordinatorWasm();

    void pageDestroyed() final;
    void didCompletePlatformRenderingUpdate() final;
    void hasNodeWithAnimatedScrollChanged(bool) final;

    const int m_viewId;
};
#endif

namespace Scrolling {

// Engine thread: wheel through the engine thread again (e.g. after a GPU loss)
void stopForView(int viewId);

// Compositor thread: wheel event to the scrolling thread, otherwise to the
// engine thread
void wheelEvent(int viewId, const WebCore::PlatformWheelEvent&);

// Compositor thread: scrolling by a finger (WebView::touchScroll), on the scrolling thread
// when it can, never with a DOM event
void touchScroll(int viewId, const WebCore::PlatformWheelEvent&);

// What moved the main frame during one run loop turn of the engine thread
struct MainFrameScrolls {
    // The engine thread itself: script, layout, a restored position, wheel or finger it handles,
    // keys, scrollbar
    bool byEngine { false };
    // Of these one by the user
    bool byEngineForUser { false };
    // Scrolls by the user it took over from the scrolling thread: wheel, finger, fling, keys
    bool fromScrollingThread { false };
};

// Engine thread: the view's event scroll for the main frame at the end of a run loop turn. The
// scrolling thread sends one itself at once when wheel or finger move the main frame there, so a
// host hides or shows its toolbar without waiting for a busy engine thread (Chrome's browser
// controls follow the compositor). The engine thread then only sends a position that is newer
void mainFrameScrolled(int viewId, WebCore::IntPoint, const MainFrameScrolls&);

// Any thread: does the page have a wheel listener at that point that can call
// preventDefault (wheel event regions)? Without a scrolling thread: yes
bool mayCancelWheelEvent(int viewId, const WebCore::PlatformWheelEvent&);

// Compositor thread, after every frame: continue scroll animations.
// true = one is running, so a frame again soon
bool displayDidRefresh(int viewId);

} // namespace Scrolling

} // namespace BrowserLite
