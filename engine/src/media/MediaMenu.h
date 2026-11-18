// The <video> and <audio> part of the context menu like Chrome: what the event 'context-menu'
// tells about the media element under the point, and its commands Loop, Show controls and
// Picture in picture (bl_media_action), which hit test the point of the menu again like Chrome's
// MediaPlayerActionAt. Picture in picture goes through the polyfill (WebRTCPolyfill.cpp), which
// leaves pictureInPictureMenu(video, command) on the window's bridge (pageBridge): 'state' answers
// 'unavailable', 'available' or 'active', 'enter' and 'exit' switch the window.
#pragma once

#include <wtf/Forward.h>

namespace WebCore {
class HitTestResult;
}

namespace BrowserLite {

// "media" of the event 'context-menu': the element the hit test found (also through its
// controls) as JSON, null without one
String mediaMenuJSON(const WebCore::HitTestResult&);

// Loop, Show controls or Picture in picture ("loop", "controls", "picture-in-picture") of the
// element the hit test found, switched on or off like Chrome's MediaPlayerAction
void mediaMenuAction(const WebCore::HitTestResult&, const String& action, bool enable);

} // namespace BrowserLite
