// view-source: addresses like in Chrome: a document of its own with history, loaded by the
// engine. WebKit has no view-source mode, so the engine fetches the address after the scheme
// (with the cookies of a navigation) and serves its text as a page with numbered lines.
#pragma once

#include <wtf/Forward.h>

namespace WebCore {
class ResourceLoader;
}

namespace BrowserLite {

// view-source:<address>
bool isViewSourceURL(const URL&);

// Serves the document of a view-source: address in the main frame; any other load of such an
// address fails (images, frames). The result reaches the loader in a later task.
void startViewSourceLoad(WebCore::ResourceLoader&);

// WebCore stopped the loader (LoaderStrategy::remove)
void cancelViewSourceLoad(WebCore::ResourceLoader&);

} // namespace BrowserLite
