// Dauerhafter HTTP-Cache der Engine (siehe HttpCache.cpp).
#pragma once

#include <WebCore/ResourceResponse.h>
#include <WebCore/SharedBuffer.h>
#include <wtf/CompletionHandler.h>
#include <wtf/WallTime.h>

namespace WebCore {
class ResourceRequest;
}

namespace BrowserLite::HttpCache {

struct Entry {
    WebCore::ResourceResponse response;
    WallTime responseTime;
    Ref<WebCore::FragmentedSharedBuffer> body;
    // Anfrage-Header, nach denen die Antwort variiert (Vary)
    Vector<std::pair<String, String>> varyingHeaders;
};

enum class Use { Fresh, Revalidate, None };

// Darf diese Anfrage aus dem Cache kommen bzw. in den Cache?
bool canUse(const WebCore::ResourceRequest&);

// Asynchron, die Antwort kommt auf dem Engine-Thread (nullptr: nichts da)
void lookup(const WebCore::ResourceRequest&, CompletionHandler<void(std::unique_ptr<Entry>&&)>&&);

// Was mit einem Eintrag fuer diese Anfrage zu tun ist
Use decide(const Entry&, const WebCore::ResourceRequest&);

// Header fuer die bedingte Anfrage (If-None-Match / If-Modified-Since)
void addValidationHeaders(WebCore::ResourceRequest&, const Entry&);

// Soll diese Antwort gespeichert werden? (vor dem Lesen des Inhalts)
bool isStorable(const WebCore::ResourceRequest&, const WebCore::ResourceResponse&);

constexpr size_t maximumEntrySize = 10 << 20;

// Asynchron speichern
void store(const WebCore::ResourceRequest&, const WebCore::ResourceResponse&, WallTime responseTime, const WebCore::FragmentedSharedBuffer& body);

} // namespace BrowserLite::HttpCache
