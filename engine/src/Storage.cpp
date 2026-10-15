// localStorage und IndexedDB kommen aus WebKitLegacy/Storage (wird mit der
// Engine gebaut, siehe engine.cmake): StorageNamespaceImpl/StorageAreaSync
// speichern localStorage in SQLite, InProcessIDBServer macht IndexedDB mit
// dem SQLite-Backend von WebCore.

#include "config.h"
#include "Storage.h"

#include "MemoryVFS.h"
#include "StorageTracker.h"
#include "WebDatabaseProvider.h"
#include "WebStorageNamespaceProvider.h"
#include <wtf/FileSystem.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/text/MakeString.h>

#if defined(BL_WASMFS)
#include "Engine.h"
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <emscripten/emscripten.h>
#include <emscripten/proxying.h>
#include <emscripten/threading.h>
#include <emscripten/wasmfs.h>
#include <sys/stat.h>
#endif

static constexpr auto dataDirectory = "/data"_s;
static constexpr auto localStorageDirectory = "/data/localstorage"_s;
static constexpr auto indexedDBDirectory = "/data/indexeddb"_s;

// In WebKitLegacy ist das pro Plattform (Mac: NSUserDefaults)
String WebDatabaseProvider::indexedDatabaseDirectoryPath()
{
    return indexedDBDirectory;
}

namespace BrowserLite {

#if defined(BL_WASMFS)

// OPFS mit synchronen Zugriffen gibt es nur in Workern eines Browsers (nicht in
// node). Laeuft im Engine-Thread.
EM_JS(int, blJsHasOPFS, (), {
    return typeof FileSystemSyncAccessHandle !== 'undefined' && !!(globalThis.navigator && navigator.storage && navigator.storage.getDirectory);
});

// Alte Daten aus dem IDBFS (vor WasmFS) hat die Oberflaeche beim Start gelesen
// (web/app.js, mountStorage). Hier als ein Block: Laenge (4 Byte), dann pro
// Datei Pfadlaenge, Pfad, Datenlaenge, Daten (je 4 Byte Laengen).
EM_JS(uint8_t*, blJsTakeLegacyStorage, (), {
    var files = Module.blLegacyStorage;
    if (!files || !files.length)
        return 0;
    var encoder = new TextEncoder();
    var paths = files.map(function (file) { return encoder.encode(file[0]); });
    var total = 4;
    files.forEach(function (file, i) { total += 8 + paths[i].length + file[1].length; });
    var pointer = _malloc(total);
    if (!pointer)
        return 0;
    var view = new DataView(HEAPU8.buffer, pointer, total);
    var offset = 0;
    view.setUint32(offset, total, true);
    offset += 4;
    files.forEach(function (file, i) {
        view.setUint32(offset, paths[i].length, true);
        HEAPU8.set(paths[i], pointer + offset + 4);
        offset += 4 + paths[i].length;
        view.setUint32(offset, file[1].length, true);
        HEAPU8.set(file[1], pointer + offset + 4);
        offset += 4 + file[1].length;
    });
    return pointer;
});

EM_JS(void, blJsLegacyStorageDone, (), {
    delete Module.blLegacyStorage;
    if (Module.onLegacyStorageMigrated)
        Module.onLegacyStorageMigrated();
});

static bool writeWholeFile(const char* path, const uint8_t* data, size_t length)
{
    // Verzeichnisse anlegen
    std::string directory = path;
    for (size_t slash = directory.find('/', 1); slash != std::string::npos; slash = directory.find('/', slash + 1))
        mkdir(directory.substr(0, slash).c_str(), 0755);
    FILE* file = fopen(path, "wb");
    if (!file)
        return false;
    bool ok = !length || fwrite(data, 1, length, file) == length;
    return !fclose(file) && ok;
}

static void migrateLegacyStorage()
{
    // Die Daten liegen im Haupt-Thread (EM_JS laeuft im aufrufenden Thread)
    uint8_t* block = nullptr;
    emscripten_proxy_sync(emscripten_proxy_get_system_queue(), emscripten_main_runtime_thread_id(), [](void* result) {
        *static_cast<uint8_t**>(result) = blJsTakeLegacyStorage();
    }, &block);
    if (!block)
        return;
    uint32_t total;
    memcpy(&total, block, 4);
    size_t offset = 4;
    unsigned count = 0;
    bool ok = true;
    auto readLength = [&] {
        uint32_t length;
        memcpy(&length, block + offset, 4);
        offset += 4;
        return length;
    };
    while (offset + 8 <= total) {
        uint32_t pathLength = readLength();
        std::string path(reinterpret_cast<char*>(block + offset), pathLength);
        offset += pathLength;
        uint32_t dataLength = readLength();
        // Nur Dateien unter /data, nichts ueberschreiben, was schon da ist
        struct stat info;
        if (!path.starts_with("/data/") || !stat(path.c_str(), &info)) {
            offset += dataLength;
            continue;
        }
        if (writeWholeFile(path.c_str(), block + offset, dataLength))
            ++count;
        else
            ok = false;
        offset += dataLength;
    }
    free(block);
    debugLog("Speicher: %u Dateien aus dem alten IDBFS uebernommen%s", count, ok ? "" : " (mit Fehlern)");
    if (ok) {
        emscripten_proxy_async(emscripten_proxy_get_system_queue(), emscripten_main_runtime_thread_id(), [](void*) {
            blJsLegacyStorageDone();
        }, nullptr);
    }
}

// /data dauerhaft ueber das OPFS-Backend von WasmFS. Zugriffe laufen ueber
// einen eigenen Worker von WasmFS, nie ueber den UI-Thread. Ohne OPFS (node,
// alte Browser) bleibt /data im Speicher. BL_OPFS=0 schaltet ab.
static void mountDataDirectory()
{
    const char* value = getenv("BL_OPFS");
    if ((value && !strcmp(value, "0")) || !blJsHasOPFS()) {
        debugLog("Speicher: /data nur im Speicher (kein OPFS)");
        return;
    }
    backend_t backend = wasmfs_create_opfs_backend();
    if (!backend || wasmfs_create_directory("/data", 0777, backend)) {
        debugLog("Speicher: OPFS nicht verfuegbar, /data nur im Speicher");
        return;
    }
    migrateLegacyStorage();
}

#endif

void initializeStorage()
{
#if defined(BL_WASMFS)
    mountDataDirectory();
#endif
    // SQLite-Datenbanken unter /data im WASM-Speicher (MemoryVFS.cpp)
    registerMemoryVFS();
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
