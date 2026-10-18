#pragma once

namespace WebCore {
class NetworkStorageSession;
class StorageSessionProvider;
}

namespace BrowserLite {

void installPlatformStrategies();

// Shared cookie/network session of all pages (curl's CookieJarDB)
WebCore::NetworkStorageSession& networkStorageSession();

} // namespace BrowserLite
