// Cache API der Seiten (caches.*), unter /data/cachestorage (CacheStorageWasm.cpp)
#pragma once

#include <wtf/Ref.h>

namespace WebCore {
class CacheStorageProvider;
}

namespace BrowserLite {

WTF::Ref<WebCore::CacheStorageProvider> createCacheStorageProvider();

}
