// Synchronous loads of a document: a synchronous XMLHttpRequest, its CORS
// preflight, external entities of XML (LoaderStrategy::loadResourceSynchronously).
#pragma once

#include <wtf/Forward.h>

namespace WebCore {
class FrameLoader;
class ResourceError;
class ResourceRequest;
class ResourceResponse;
struct FetchOptions;
}

namespace BrowserLite {

// Loads the request to the end while the calling script waits. The engine
// thread is the only one that gets curl's answers, so it does not block: like
// below a dialog (#258) the page's group is held and the other views go on.
// HTTP cache and cookies like any load, redirects are followed; WebCore checks
// CORS of the result. Not during unload, pagehide or beforeunload (like Chrome).
void loadSynchronously(WebCore::FrameLoader&, const WebCore::ResourceRequest&, const WebCore::FetchOptions&, WebCore::ResourceError&, WebCore::ResourceResponse&, Vector<uint8_t>& data);

} // namespace BrowserLite
