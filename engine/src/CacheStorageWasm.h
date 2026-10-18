// Cache API of the pages (caches.*), under /data/cachestorage (CacheStorageWasm.cpp)
#pragma once

#include <cstdint>
#include <wtf/Ref.h>

namespace WebCore {
class CacheStorageProvider;
struct ClientOrigin;
}

namespace BrowserLite {

WTF::Ref<WebCore::CacheStorageProvider> createCacheStorageProvider();
// Disk space used by the Cache API of an origin
uint64_t cacheStorageUsage(const WebCore::ClientOrigin&);

}
