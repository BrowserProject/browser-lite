// Speicher der Seiten: Cookies, localStorage und IndexedDB liegen unter /data.
// Mit WasmFS ist /data ein Verzeichnis im OPFS des Host-Browsers (Storage.cpp),
// sonst haengt die Oberflaeche dort ein IDBFS ein und speichert es regelmaessig.
// So bleibt alles nach einem Neuladen erhalten. Ohne Host (node-Tests) ist /data
// nur im Speicher.
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
