// A navigation of the user stops the script of the page it leaves (UserNavigation.cpp).
#pragma once

#include <wtf/Forward.h>

namespace JSC {
class JSGlobalObject;
}

namespace WebCore {
class Document;
}

namespace BrowserLite {

// On the host's thread, in the export of the command (bl_load_url, bl_go): the user waits for a
// navigation of the view, which the engine thread takes once its running task ends. An offset
// goes back (negative) or forward in the history, an address is loaded like typed. Returns the
// request for userNavigationTaken.
uint64_t userNavigationRequested(int viewID, int offset);
uint64_t userNavigationRequested(int viewID, const String& address);

// On the engine thread, when the command of the request runs
void userNavigationTaken(uint64_t request);

// On the engine thread, in the script watchdog while an entry into JS runs: whether a waiting
// navigation of the user leaves the document of the main frame of the page this global object
// belongs to. Then the document of the script stays out of the back/forward cache.
bool userNavigationStopsScript(JSC::JSGlobalObject&);

// Whether a script of this document was stopped for a navigation of the user (FrameLoaderClient)
bool scriptStoppedForUserNavigation(const WebCore::Document&);

} // namespace BrowserLite
