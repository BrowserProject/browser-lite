// Persistent HTTP cache of the engine (see HttpCache.cpp).
#pragma once

#include <WebCore/FetchOptions.h>
#include <WebCore/ResourceRequest.h>
#include <WebCore/ResourceResponse.h>
#include <WebCore/SharedBuffer.h>
#include <wtf/CompletionHandler.h>
#include <wtf/WallTime.h>

namespace WebCore {
class LocalFrame;
class Page;
class ResourceLoader;
class SecurityOrigin;
struct SecurityOriginData;
}

namespace BrowserLite::HttpCache {

struct Entry {
    WebCore::ResourceResponse response;
    WallTime responseTime;
    Ref<WebCore::FragmentedSharedBuffer> body;
    // Request headers the response varies by (Vary)
    Vector<std::pair<String, String>> varyingHeaders;
};

enum class Use { Fresh, Revalidate, None };

// Partition of the cache like the key of Chrome's HTTP cache: site of the top
// frame, site of the frame, and whether the load is the document of a subframe.
// Format "<top site> <frame site>", with "s_" in front for the document of a
// subframe; a site is scheme://registrable domain. Null for an opaque origin or
// one without a site (file:): such loads are not cached. Also part of the
// bytecode cache key.
String partition(const WebCore::SecurityOriginData& topOrigin, const WebCore::SecurityOriginData& frameOrigin, bool isSubframeDocument);

// Partition of a load of this frame. Top site from the origin of
// request.firstPartyForCookies() (a blob: URL: its creator), frame site from the
// origin of the context that loads (requester, the CachedResource's origin:
// document or worker), for a navigation from its target URL. If the requester is
// opaque or missing (a CORS load after a cross-origin redirect) from the frame's
// context: the worker of a worker page (setWorkerOrigin), else the document.
// Workers load through a document whose firstPartyForCookies is their top origin:
// a service worker or shared worker through the placeholder document of its own
// page (top origin of the registration or creator), a dedicated worker through
// its creator's document.
String partition(const WebCore::LocalFrame&, const WebCore::ResourceRequest&, const WebCore::FetchOptions&, const WebCore::SecurityOrigin* requester);

// Origin of the service worker or shared worker that runs in this page (its
// placeholder document has an opaque origin)
void setWorkerOrigin(WebCore::Page&, const WebCore::SecurityOriginData&);
// The same for a running load (its current request)
String partition(const WebCore::ResourceLoader&);

// May this request come from the cache or go into it?
bool canUse(const WebCore::ResourceRequest&);

// Asynchronous, the answer arrives on the engine thread (nullptr: nothing there)
void lookup(const String& partition, const WebCore::ResourceRequest&, CompletionHandler<void(std::unique_ptr<Entry>&&)>&&);

// What to do with an entry for this request
Use decide(const Entry&, const WebCore::ResourceRequest&);

// Headers for the conditional request (If-None-Match / If-Modified-Since)
void addValidationHeaders(WebCore::ResourceRequest&, const Entry&);

// Should this response be stored? (before reading the body)
bool isStorable(const String& partition, const WebCore::ResourceRequest&, const WebCore::ResourceResponse&);

constexpr size_t maximumEntrySize = 10 << 20;

// Stores asynchronously
void store(const String& partition, const WebCore::ResourceRequest&, const WebCore::ResourceResponse&, WallTime responseTime, const WebCore::FragmentedSharedBuffer& body);

// What a loader does with the cache before the network (LoaderStrategy, in the
// service worker background update and navigation preload)
struct Lookup {
    // For the network, to revalidate with If-None-Match/If-Modified-Since
    WebCore::ResourceRequest request;
    // fresh: the response. Otherwise the entry for a 304 response (or none)
    std::unique_ptr<Entry> entry;
    bool fresh { false };
};
// Arrives on the engine thread, right away without cache (canUse, reload
// without cache, null partition). alwaysRevalidate: revalidate even a fresh entry
void lookupForLoad(const String& partition, WebCore::ResourceRequest&&, bool alwaysRevalidate, CompletionHandler<void(Lookup&&)>&&);

// 304 on the conditional request: entry with the new headers, stored again
void didRevalidate(const String& partition, const WebCore::ResourceRequest&, Entry&, const WebCore::ResourceResponse& notModified);

} // namespace BrowserLite::HttpCache
