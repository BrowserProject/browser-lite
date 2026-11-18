// Selection handles like Chrome on phones (ui/touch_selection) and Safari: a selection a long press
// made gets two handles from the host. The engine sends the edges of the selection's start and end
// in view coordinates (event 'touch-selection') after every rendering update that moved them, and
// a handle the host drags moves its end of the selection to the point (bl_selection_handle), like
// WebKit's text interaction on iOS without flipping: the selection keeps at least one character.
// Any other change of the selection (a tap, typing, script) ends the handles, Select all keeps them.
#pragma once

#include <WebCore/FloatPoint.h>
#include <wtf/Function.h>
#include <wtf/WeakPtr.h>
#include <wtf/text/WTFString.h>

namespace WebCore {
class LocalFrame;
class Page;
}

namespace BrowserLite {

class TouchSelection {
public:
    explicit TouchSelection(int viewId)
        : m_viewId(viewId)
    {
    }

    // Runs a change of the selection that gets handles (the long press, a drag, Select all): when
    // the focused frame has a range selection afterwards, the handles show it
    void change(WebCore::Page&, const Function<void()>&);
    // The selection of a frame changed (EditorClient): the handles end, unless change() runs
    void selectionChanged(WebCore::LocalFrame&);
    // After a rendering update: the edges to the host when they changed
    void update(WebCore::Page&);
    bool isActive() const { return !!m_frame; }
    // A handle moved to a point of the view (CSS pixels): the start (end false) or end of the
    // selection goes to the closest position there
    void moveHandle(bool end, WebCore::FloatPoint);
    // Where the menu of the selection opens after a drag: below the edge of that end
    std::optional<WebCore::FloatPoint> menuPoint(bool end);
    // The selection is editable (the menu offers Cut and Paste)
    bool isEditable() const;

private:
    void end();
    int m_viewId;
    WeakPtr<WebCore::LocalFrame> m_frame;
    bool m_changing { false };
    // The last payload sent, empty when the host shows no handles
    String m_sent;
};

} // namespace BrowserLite
