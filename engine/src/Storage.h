// Speicher der Seiten: Cookies, localStorage und IndexedDB liegen unter /data.
// Mit WasmFS ist /data ein Verzeichnis im OPFS des Host-Browsers (Storage.cpp),
// sonst haengt die Oberflaeche dort ein IDBFS ein und speichert es regelmaessig.
// So bleibt alles nach einem Neuladen erhalten. Ohne Host (node-Tests) ist /data
// nur im Speicher.
#pragma once

#include <cstdint>
#include <span>
#include <vector>
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

// Ganze Dateien unter /data (Datenbanken, Cache API). Ersetzen schreibt erst
// eine Kopie in /data/tmp und benennt sie dann um: bricht das Schreiben ab
// (Tab zu, Platte voll), bleibt die alte Datei ganz (initializeStorage leert
// /data/tmp beim naechsten Start). Ohne malloc,
// das MemoryVFS ruft es auf dem Haupt-Thread auch unter einem Lock auf.
bool replaceWholeFile(const char* path, std::span<const uint8_t>);

// Nur "gibt es nicht" ist Missing. Jeder andere Fehler (z.B. ist das OPFS von
// einem anderen Tab belegt) ist Failed, damit niemand eine leere Datei ueber
// die echte schreibt.
enum class ReadResult : uint8_t { Done, Missing, Failed };
ReadResult readWholeFile(const char* path, std::vector<uint8_t>&);

} // namespace BrowserLite
