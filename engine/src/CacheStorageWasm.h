// Cache API der Seiten (caches.*), unter /data/cachestorage (CacheStorageWasm.cpp)
#pragma once

#include <cstdint>
#include <wtf/Ref.h>

namespace WebCore {
class CacheStorageProvider;
struct ClientOrigin;
}

namespace BrowserLite {

WTF::Ref<WebCore::CacheStorageProvider> createCacheStorageProvider();
// Belegter Platz der Cache API eines Ursprungs auf der Platte
uint64_t cacheStorageUsage(const WebCore::ClientOrigin&);

}
