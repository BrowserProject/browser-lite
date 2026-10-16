// Pinch-Zoom wie Chrome: Touchpad (Strg + Rad) und zwei Finger skalieren nur
// die Ansicht (Page::setPageScaleFactor, visual viewport). Die Layout-Breite
// bleibt, jede Uebernahme kostet einen Style- und Layout-Durchlauf.
//
// Mit Compositor-Thread zeigt der Compositor die Geste sofort mit den alten
// Kacheln (LayerTreeHostWasm.cpp), der Engine-Thread uebernimmt das Ziel erst
// am Ende der Geste und malt dann scharf. Bis dahin verschiebt das Rad das
// Ziel (CompositorScene::scrollPinch). Ohne Compositor skaliert der
// Engine-Thread bei jedem Schritt (WebView.cpp).
#pragma once

#include <WebCore/FloatPoint.h>
#include <WebCore/FloatRect.h>
#include <algorithm>

namespace BrowserLite {

// Von der Oberflaeche (bl_pinch)
enum class PinchPhase : uint8_t { Begin, Update, End, Cancel };

// Ansicht des Hauptframes: Skalierung, Scroll-Position (in skalierten
// Koordinaten wie ScrollView::scrollPosition), Dokument ohne Skalierung und
// sichtbare Groesse ohne Scrollbalken (CSS-Pixel)
struct PinchViewport {
    float scale { 1 };
    WebCore::FloatPoint scrollPosition;
    WebCore::FloatRect documentRect;
    WebCore::FloatSize visibleSize;
};

// Eine Geste: der Inhalt unter dem Mittelpunkt (Finger bzw. Mauszeiger) bleibt
// darunter, Verschieben der Finger verschiebt die Ansicht
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

    // factor relativ zum letzten Schritt, focus in der View (CSS-Pixel)
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

    // Scrollen in skalierten Koordinaten
    void scrollBy(WebCore::FloatSize delta)
    {
        m_target.scrollPosition = clampScrollPosition(m_target, m_target.scrollPosition + delta);
    }

    // Abgebrochen (die Seite will die Finger selber): zurueck zum Anfang
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
