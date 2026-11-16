// The clipboard of the host browser for the pages: a paste puts it on the engine
// clipboard (bl_set_clipboard), navigator.clipboard.read() and readText() ask for it
// after the permission 'clipboard-read' of the top page, like Chrome.
#pragma once

#include <wtf/CompletionHandler.h>
#include <wtf/Forward.h>

namespace BrowserLite {

// Puts {"text", "html", "files": [engine paths]} of the host on the engine clipboard (engine thread)
void setClipboardFromHost(const String& json);

// Permission of the origin, then the event 'clipboard-read'; true once the host clipboard is on
// the engine clipboard (engine thread)
void requestHostClipboard(int viewId, const String& origin, CompletionHandler<void(bool)>&&);

// Answer of the host: its clipboard like setClipboardFromHost, null when it gave none (engine thread)
void answerClipboardRead(int requestId, const String& json);

} // namespace BrowserLite
