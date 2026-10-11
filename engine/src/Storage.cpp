// localStorage und IndexedDB kommen aus WebKitLegacy/Storage (wird mit der
// Engine gebaut, siehe engine.cmake): StorageNamespaceImpl/StorageAreaSync
// speichern localStorage in SQLite, InProcessIDBServer macht IndexedDB mit
// dem SQLite-Backend von WebCore.

#include "config.h"
#include "Storage.h"

#include "StorageTracker.h"
#include "WebDatabaseProvider.h"
#include "WebStorageNamespaceProvider.h"
#include <wtf/FileSystem.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/text/MakeString.h>

static constexpr auto dataDirectory = "/data"_s;
static constexpr auto localStorageDirectory = "/data/localstorage"_s;
static constexpr auto indexedDBDirectory = "/data/indexeddb"_s;

// In WebKitLegacy ist das pro Plattform (Mac: NSUserDefaults)
String WebDatabaseProvider::indexedDatabaseDirectoryPath()
{
    return indexedDBDirectory;
}

namespace BrowserLite {

void initializeStorage()
{
    FileSystem::makeAllDirectories(localStorageDirectory);
    FileSystem::makeAllDirectories(indexedDBDirectory);
    WebKit::StorageTracker::initializeTracker(localStorageDirectory, nullptr);
}

String cookieDatabasePath()
{
    return makeString(dataDirectory, "/cookies.db"_s);
}

WebCore::StorageNamespaceProvider& storageNamespaceProvider()
{
    static NeverDestroyed<Ref<WebKit::WebStorageNamespaceProvider>> provider = WebKit::WebStorageNamespaceProvider::create(localStorageDirectory);
    return provider.get();
}

WebCore::DatabaseProvider& databaseProvider()
{
    return WebDatabaseProvider::singleton();
}

} // namespace BrowserLite
