// Dauerhafter HTTP-Cache der Engine (siehe HttpCache.cpp).
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

// Was ein Lader vor dem Netz mit dem Cache macht (LoaderStrategy, im Service
// Worker Hintergrund-Aktualisierung und Navigation Preload)
struct Lookup {
    // Fuers Netz, zum Nachpruefen mit If-None-Match/If-Modified-Since
    WebCore::ResourceRequest request;
    // fresh: die Antwort. Sonst der Eintrag fuer eine 304-Antwort (oder keiner)
    std::unique_ptr<Entry> entry;
    bool fresh { false };
};
// Kommt auf dem Engine-Thread an, ohne Cache (canUse, Neuladen ohne Cache)
// sofort. alwaysRevalidate: auch einen frischen Eintrag nachpruefen
void lookupForLoad(WebCore::ResourceRequest&&, bool alwaysRevalidate, CompletionHandler<void(Lookup&&)>&&);

// 304 auf die bedingte Anfrage: Eintrag mit den neuen Headern, neu gespeichert
void didRevalidate(const WebCore::ResourceRequest&, Entry&, const WebCore::ResourceResponse& notModified);

} // namespace BrowserLite::HttpCache
