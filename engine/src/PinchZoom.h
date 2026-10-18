// Pinch zoom like Chrome: touchpad (Ctrl + wheel) and two fingers only scale
// the view (Page::setPageScaleFactor, visual viewport). The layout width
// stays, every takeover costs a style and layout pass.
//
// With the compositor thread the compositor shows the gesture right away with
// the old tiles (LayerTreeHostWasm.cpp), the engine thread only takes over the
// target at the end of the gesture and then paints sharp. Until then the wheel
// moves the target (CompositorScene::scrollPinch). Without the compositor the
// engine thread scales on every step (WebView.cpp).
#pragma once

#include <WebCore/FloatPoint.h>
#include <WebCore/FloatRect.h>
#include <algorithm>

namespace BrowserLite {

// From the host (bl_pinch)
enum class PinchPhase : uint8_t { Begin, Update, End, Cancel };

// View of the main frame: scale, scroll position (in scaled coordinates like
// ScrollView::scrollPosition), document without scaling and visible size
// without scrollbars (CSS pixels)
struct PinchViewport {
    float scale { 1 };
    WebCore::FloatPoint scrollPosition;
    WebCore::FloatRect documentRect;
    WebCore::FloatSize visibleSize;
};

// One gesture: the content under the focus point (fingers or mouse pointer)
// stays under it, moving the fingers moves the view
class PinchZoom {
public:
    static constexpr float minimumScale = 1;
    static constexpr float maximumScale = 4;

    PinchZoom(const PinchViewport& start, WebCore::FloatPoint focus)
        : m_start(start)
        , m_target(start)
        , m_focus(focus)
    {
    }

    const PinchViewport& start() const { return m_start; }
    const PinchViewport& target() const { return m_target; }

    // factor relative to the last step, focus in the view (CSS pixels)
    void update(float factor, WebCore::FloatPoint focus)
    {
        float oldScale = m_target.scale;
        float scale = std::clamp(oldScale * factor, minimumScale, maximumScale);
        float contentX = (m_focus.x() + m_target.scrollPosition.x()) / oldScale;
        float contentY = (m_focus.y() + m_target.scrollPosition.y()) / oldScale;
        m_target.scale = scale;
        m_target.scrollPosition = clampScrollPosition(m_target, { contentX * scale - focus.x(), contentY * scale - focus.y() });
        m_focus = focus;
    }

    // Scrolling in scaled coordinates
    void scrollBy(WebCore::FloatSize delta)
    {
        m_target.scrollPosition = clampScrollPosition(m_target, m_target.scrollPosition + delta);
    }

    // Cancelled (the page wants the fingers itself): back to the start
    void cancel() { m_target = m_start; }

private:
    static WebCore::FloatPoint clampScrollPosition(const PinchViewport& viewport, WebCore::FloatPoint position)
    {
        auto& document = viewport.documentRect;
        float minX = document.x() * viewport.scale;
        float minY = document.y() * viewport.scale;
        float maxX = std::max(minX, document.maxX() * viewport.scale - viewport.visibleSize.width());
        float maxY = std::max(minY, document.maxY() * viewport.scale - viewport.visibleSize.height());
        return { std::clamp(position.x(), minX, maxX), std::clamp(position.y(), minY, maxY) };
    }

    PinchViewport m_start;
    PinchViewport m_target;
    WebCore::FloatPoint m_focus;
};

} // namespace BrowserLite
