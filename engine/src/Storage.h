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
#include <wtf/ScopedLambda.h>

namespace WebCore {
class DatabaseProvider;
class StorageNamespaceProvider;
struct ClientOrigin;
}

namespace BrowserLite {

void initializeStorage();

String cookieDatabasePath();
WebCore::StorageNamespaceProvider& storageNamespaceProvider();
WebCore::DatabaseProvider& databaseProvider();

// Grenze fuer IndexedDB pro Ursprung (BL_INDEXEDDB_QUOTA_MB, sonst 256 MB) und
// der Platz, den die Datenbanken eines Ursprungs dafuer belegen
uint64_t indexedDBQuota();
uint64_t indexedDBUsage(const WebCore::ClientOrigin&);
// Alle Dateien unter directory auf der Platte
uint64_t directorySize(const String& directory);

// Ganze Dateien unter /data (Datenbanken, Cache API) ersetzen: erst eine Kopie
// in /data/tmp schreiben, dann umbenennen. Bricht das Schreiben ab (Tab zu,
// Platte voll), bleibt die alte Datei ganz (initializeStorage leert /data/tmp
// beim naechsten Start). Ohne malloc, das MemoryVFS schreibt auf dem
// Haupt-Thread auch unter einem Lock.
class FileReplacement {
public:
    FileReplacement();
    ~FileReplacement();
    FileReplacement(const FileReplacement&) = delete;
    FileReplacement& operator=(const FileReplacement&) = delete;

    // An eine Stelle der Kopie schreiben bzw. ihre Laenge setzen
    void write(std::span<const uint8_t>, uint64_t offset);
    void truncate(uint64_t size);
    // false: schon beim Schreiben ging etwas schief
    bool ok() const { return m_fd >= 0 && m_ok; }
    // Die Kopie ersetzt path. false: etwas ging schief, path ist wie vorher
    bool commit(const char* path);

private:
    char m_temporary[64];
    int m_fd { -1 };
    bool m_ok { true };
};

bool replaceWholeFile(const char* path, std::span<const uint8_t>);

// Nur "gibt es nicht" ist Missing. Jeder andere Fehler (z.B. ist das OPFS von
// einem anderen Tab belegt) ist Failed, damit niemand eine leere Datei ueber
// die echte schreibt.
enum class ReadResult : uint8_t { Done, Missing, Failed };
ReadResult readWholeFile(const char* path, std::vector<uint8_t>&);
// In Stuecken, ohne alles an einem Stueck im Speicher. append false: Failed
ReadResult readWholeFile(const char* path, const ScopedLambda<bool(std::span<const uint8_t>)>& append);

} // namespace BrowserLite
