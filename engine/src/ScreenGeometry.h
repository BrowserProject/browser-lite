// Where the host shows the views on the screen (bl_set_window, bl_set_view_origin): the browser
// window around them gives window.screenX/Y and outerWidth/Height, the screen position of a view
// the screen coordinates of its input events (screenX/Y of mouse, pointer, touch, wheel and drag
// events, Element::screenRect). Set on the host's main thread, read on any thread (wheel events
// are made on the host's).
#pragma once

#include <WebCore/DoublePoint.h>
#include <WebCore/FloatPoint.h>
#include <WebCore/FloatRect.h>

namespace BrowserLite::ScreenGeometry {

// The host window: its top left corner on the screen and its outer size
void setWindow(const WebCore::FloatRect&);
// The window of a view of this size, at least as big as the view; before the host sent one the
// view itself at 0, 0
WebCore::FloatRect window(const WebCore::FloatSize& viewSize);

// The screen position of the top left corner of a view
void setViewOrigin(int viewId, const WebCore::FloatPoint&);
void forgetView(int viewId);
// A point of the view (root view coordinates) on the screen
WebCore::DoublePoint toScreen(int viewId, const WebCore::DoublePoint&);
// A point of the screen in the view
WebCore::DoublePoint fromScreen(int viewId, const WebCore::DoublePoint&);

} // namespace BrowserLite::ScreenGeometry
