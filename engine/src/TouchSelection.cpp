#include "config.h"
#include "TouchSelection.h"

#include "Host.h"

#include <WebCore/DocumentInlines.h>
#include <WebCore/DocumentView.h>
#include <WebCore/Editing.h>
#include <WebCore/EventHandler.h>
#include <WebCore/FocusController.h>
#include <WebCore/FrameDestructionObserverInlines.h>
#include <WebCore/FrameSelection.h>
#include <WebCore/HTMLElement.h>
#include <WebCore/HitTestResult.h>
#include <WebCore/LocalFrame.h>
#include <WebCore/LocalFrameInlines.h>
#include <WebCore/LocalFrameView.h>
#include <WebCore/NodeInlines.h>
#include <WebCore/Page.h>
#include <WebCore/RenderBlock.h>
#include <WebCore/RenderObjectInlines.h>
#include <WebCore/RenderView.h>
#include <WebCore/VisiblePosition.h>
#include <WebCore/VisibleRectContext.h>
#include <WebCore/VisibleSelection.h>
#include <wtf/SetForScope.h>
#include <wtf/text/MakeString.h>

namespace BrowserLite {
using namespace WebCore;

namespace {

// The caret line at one end of the selection, in view coordinates; visible false when the
// overflow of a box or a frame clips it
struct Edge {
    FloatRect rect;
    bool visible { false };
};

}

static std::optional<Edge> edgeOf(const VisiblePosition& position, LocalFrame& frame)
{
    RefPtr view = frame.view();
    RenderBlock* renderer = nullptr;
    auto local = localCaretRectInRendererForCaretPainting(position, renderer);
    if (!view || !renderer || local.isEmpty())
        return std::nullopt;
    renderer->flipForWritingMode(local);
    auto absolute = renderer->localToAbsoluteQuad(FloatRect(local), MapCoordinatesMode::UseTransforms).boundingBox();
    VisibleRectContext context {
        .hasPositionFixedDescendant = false,
        .dirtyRectIsFlipped = false,
        .descendantNeedsEnclosingIntRect = false,
        .options = { VisibleRectContext::Option::UseEdgeInclusiveIntersection, VisibleRectContext::Option::ApplyCompositedClips },
        .scrollMargin = { },
    };
    bool visible = !!renderer->computeVisibleRectsInContainer({ local }, &renderer->view(), context);
    // In a frame also inside the frame's visible part (the view's own edges are the host's)
    if (visible && !frame.isMainFrame()) {
        CheckedPtr owner = frame.ownerRenderer();
        visible = view->visibleContentRect().contains(roundedIntPoint(absolute.center())) && owner && !owner->hasEmptyVisibleRectRespectingParentFrames();
    }
    return Edge { view->contentsToRootView(absolute), visible };
}

static String edgeJSON(const Edge& edge)
{
    return makeString("{\"x\":"_s, edge.rect.x(), ",\"y\":"_s, edge.rect.y(), ",\"height\":"_s, edge.rect.height(),
        ",\"visible\":"_s, edge.visible ? "true"_s : "false"_s, '}');
}

void TouchSelection::change(Page& page, const Function<void()>& function)
{
    {
        SetForScope changing { m_changing, true };
        function();
    }
    RefPtr frame = page.focusController().focusedOrMainFrame();
    if (frame && frame->selection().selection().isRange())
        m_frame = frame.get();
    else
        end();
}

void TouchSelection::selectionChanged(LocalFrame& frame)
{
    if (!m_changing && m_frame.get() == &frame)
        end();
}

void TouchSelection::end()
{
    m_frame = nullptr;
    if (!m_sent.isEmpty()) {
        m_sent = { };
        notifyHost(m_viewId, "touch-selection", "{}"_s);
    }
}

void TouchSelection::update(Page& page)
{
    RefPtr frame = m_frame.get();
    if (!frame)
        return;
    auto& selection = frame->selection().selection();
    if (frame->page() != &page || page.focusController().focusedOrMainFrame() != frame.get() || !selection.isRange()) {
        end();
        return;
    }
    auto start = edgeOf(selection.visibleStart(), *frame);
    auto end = edgeOf(selection.visibleEnd(), *frame);
    if (!start || !end) {
        this->end();
        return;
    }
    auto payload = makeString("{\"start\":"_s, edgeJSON(*start), ",\"end\":"_s, edgeJSON(*end), '}');
    if (payload == m_sent)
        return;
    m_sent = payload;
    notifyHost(m_viewId, "touch-selection", payload);
}

// Like rangeForPointInRootViewCoordinates of WebKit's WebPageIOS.mm without flipping: the point of
// the moved end stays on the other end's side (vertically) and the position there, found like
// for a mouse drag (within the editable element of an editable selection), never reaches the other
// end, so at least one character stays selected
void TouchSelection::moveHandle(bool movesEnd, FloatPoint point)
{
    RefPtr frame = m_frame.get();
    RefPtr page = frame ? frame->page() : nullptr;
    RefPtr view = frame ? frame->view() : nullptr;
    RefPtr document = frame ? frame->document() : nullptr;
    if (!page || !view || !document)
        return;
    document->updateLayoutIgnorePendingStylesheets();
    auto selection = frame->selection().selection();
    if (!selection.isRange())
        return;
    auto start = selection.visibleStart();
    auto end = selection.visibleEnd();
    auto pointInDocument = view->rootViewToContents(roundedIntPoint(point));
    if (movesEnd)
        pointInDocument.setY(std::max(pointInDocument.y(), start.absoluteCaretBounds().center().y()));
    else
        pointInDocument.setY(std::min(pointInDocument.y(), end.absoluteCaretBounds().center().y()));

    auto hit = frame->eventHandler().hitTestResultAtPoint(pointInDocument, { HitTestRequest::Type::ReadOnly, HitTestRequest::Type::Active, HitTestRequest::Type::AllowVisibleChildFrameContentOnly });
    RefPtr target = hit.targetNode();
    if (target && !HTMLElement::shouldExtendSelectionToTargetNode(*target, selection))
        return;
    VisiblePosition position = target ? frame->eventHandler().selectionExtentRespectingEditingBoundary(selection, hit.localPoint(), target.get()) : frame->visiblePositionForPoint(pointInDocument);
    if (position.isNull())
        return;
    if (movesEnd && position <= start)
        position = start.next();
    else if (!movesEnd && position >= end)
        position = end.previous();
    if (position.isNull())
        return;
    // The other end stays the anchor, the moved one is the focus, which the selection reveals
    VisibleSelection moved { movesEnd ? start : end, position };
    if (!moved.isRange() || moved == selection)
        return;
    change(*page, [&] {
        frame->selection().setSelection(moved, FrameSelection::defaultSetSelectionOptions(UserTriggered::Yes));
    });
}

std::optional<FloatPoint> TouchSelection::menuPoint(bool atEnd)
{
    RefPtr frame = m_frame.get();
    RefPtr document = frame ? frame->document() : nullptr;
    if (!document)
        return std::nullopt;
    document->updateLayoutIgnorePendingStylesheets();
    auto& selection = frame->selection().selection();
    auto edge = edgeOf(atEnd ? selection.visibleEnd() : selection.visibleStart(), *frame);
    if (!edge)
        return std::nullopt;
    return edge->rect.minXMaxYCorner();
}

bool TouchSelection::isEditable() const
{
    RefPtr frame = m_frame.get();
    return frame && frame->selection().selection().isContentEditable();
}

} // namespace BrowserLite
