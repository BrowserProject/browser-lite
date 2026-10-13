// Cache API der Seiten (caches.*), im Speicher der Engine (CacheStorageWasm.cpp)
#pragma once

#include <wtf/Ref.h>

namespace WebCore {
class CacheStorageProvider;
}

namespace BrowserLite {

WTF::Ref<WebCore::CacheStorageProvider> createCacheStorageProvider();

}
