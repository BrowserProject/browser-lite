#pragma once

#include <wtf/UniqueRef.h>

namespace WebCore {
class CryptoClient;
}

namespace BrowserLite {

// Serialization of CryptoKeys for structuredClone, postMessage and IndexedDB of pages and
// workers (CryptoKeys.cpp). Without it every clone of a CryptoKey is a DataCloneError.
UniqueRef<WebCore::CryptoClient> createCryptoClient();

} // namespace BrowserLite
