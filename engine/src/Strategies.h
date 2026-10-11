#pragma once

namespace WebCore {
class NetworkStorageSession;
class StorageSessionProvider;
}

namespace BrowserLite {

void installPlatformStrategies();

// Gemeinsame Cookie-/Netzwerk-Session aller Seiten (CookieJarDB von curl)
WebCore::NetworkStorageSession& networkStorageSession();

} // namespace BrowserLite
