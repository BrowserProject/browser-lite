// Persistent HTTP cache of the engine (see HttpCache.cpp).
#pragma once

#include <WebCore/ResourceRequest.h>
#include <WebCore/ResourceResponse.h>
#include <WebCore/SharedBuffer.h>
#include <wtf/CompletionHandler.h>
#include <wtf/WallTime.h>

namespace BrowserLite::HttpCache {

struct Entry {
    WebCore::ResourceResponse response;
    WallTime responseTime;
    Ref<WebCore::FragmentedSharedBuffer> body;
    // Request headers the response varies by (Vary)
    Vector<std::pair<String, String>> varyingHeaders;
};

enum class Use { Fresh, Revalidate, None };

// May this request come from the cache or go into it?
bool canUse(const WebCore::ResourceRequest&);

// Asynchronous, the answer arrives on the engine thread (nullptr: nothing there)
void lookup(const WebCore::ResourceRequest&, CompletionHandler<void(std::unique_ptr<Entry>&&)>&&);

// What to do with an entry for this request
Use decide(const Entry&, const WebCore::ResourceRequest&);

// Headers for the conditional request (If-None-Match / If-Modified-Since)
void addValidationHeaders(WebCore::ResourceRequest&, const Entry&);

// Should this response be stored? (before reading the body)
bool isStorable(const WebCore::ResourceRequest&, const WebCore::ResourceResponse&);

constexpr size_t maximumEntrySize = 10 << 20;

// Stores asynchronously
void store(const WebCore::ResourceRequest&, const WebCore::ResourceResponse&, WallTime responseTime, const WebCore::FragmentedSharedBuffer& body);

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
// without cache). alwaysRevalidate: revalidate even a fresh entry
void lookupForLoad(WebCore::ResourceRequest&&, bool alwaysRevalidate, CompletionHandler<void(Lookup&&)>&&);

// 304 on the conditional request: entry with the new headers, stored again
void didRevalidate(const WebCore::ResourceRequest&, Entry&, const WebCore::ResourceResponse& notModified);

} // namespace BrowserLite::HttpCache
