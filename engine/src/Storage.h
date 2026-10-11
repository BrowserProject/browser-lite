// Speicher der Seiten: Cookies, localStorage und IndexedDB liegen unter /data.
// Die Oberflaeche haengt dort ein IndexedDB-Dateisystem (IDBFS) des Host-
// Browsers ein und speichert es regelmaessig, so bleibt alles nach einem
// Neuladen erhalten. Ohne Host (node-Tests) ist /data nur im Speicher.
#pragma once

#include <wtf/Forward.h>

namespace WebCore {
class DatabaseProvider;
class StorageNamespaceProvider;
}

namespace BrowserLite {

void initializeStorage();

String cookieDatabasePath();
WebCore::StorageNamespaceProvider& storageNamespaceProvider();
WebCore::DatabaseProvider& databaseProvider();

} // namespace BrowserLite
