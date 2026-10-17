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
#include "Engine.h"
#include <WebCore/ClientOrigin.h>
#include <WebCore/IDBDatabaseIdentifier.h>
#include <cerrno>
#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
#include <wtf/FileSystem.h>
#include <wtf/HashMap.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/text/MakeString.h>

#include <cstring>
#include <emscripten/emscripten.h>
#include <emscripten/wasmfs.h>

static constexpr auto dataDirectory = "/data"_s;
static constexpr auto localStorageDirectory = "/data/localstorage"_s;
static constexpr auto indexedDBDirectory = "/data/indexeddb"_s;
// Kopien von FileReplacement und die Uploads der Tabs (web/app.js), ausserhalb
// von /data/opfs, wo die Seiten die Namen waehlen. Wird beim Start geleert.
static constexpr auto temporaryDirectory = "/data/tmp"_s;

// In WebKitLegacy ist das pro Plattform (Mac: NSUserDefaults)
String WebDatabaseProvider::indexedDatabaseDirectoryPath()
{
    return indexedDBDirectory;
}

// Grenze fuer IndexedDB pro Ursprung (Patch 0040), gerechnet wie
// OriginQuotaManager in WebKit2: ein Vorrat bis zur Grenze, erst wenn er
// aufgebraucht ist, wird neu gezaehlt (indexedDBUsage). Offene
// Datenbanken liegen ganz im WASM-Speicher (MemoryVFS.cpp), der hoechstens
// 4 GB hat und nie schrumpft. Oeffnen, Lesen und Loeschen brauchen keinen
// Platz, eine Seite an der Grenze kommt also an ihre Daten; zu grosse Dateien
// laedt das VFS nicht (BL_DATABASE_MAX_MB). Laeuft im Thread des IDBServer.
bool WebDatabaseProvider::requestIndexedDatabaseSpace(const WebCore::ClientOrigin& origin, uint64_t size)
{
    uint64_t quota = BrowserLite::indexedDBQuota();
    static NeverDestroyed<HashMap<WebCore::ClientOrigin, uint64_t>> remaining;
    auto& left = remaining->add(origin, 0).iterator->value;
    if (size > left) {
        uint64_t usage = BrowserLite::indexedDBUsage(origin);
        left = usage < quota ? quota - usage : 0;
        if (size > left)
            BrowserLite::log("IndexedDB: Grenze von %llu MB erreicht (%llu MB belegt)", static_cast<unsigned long long>(quota >> 20), static_cast<unsigned long long>(usage >> 20));
    }
    if (size > left)
        return false;
    left -= size;
    return true;
}

namespace BrowserLite {

uint64_t indexedDBQuota()
{
    static const uint64_t quota = [] {
        const char* value = getenv("BL_INDEXEDDB_QUOTA_MB");
        return (value && *value ? strtoull(value, nullptr, 10) : 256) << 20;
    }();
    return quota;
}

// Wie SQLiteIDBBackingStore::databasesSizeForDirectory: ein Ordner pro
// Datenbank (mit ihren Blobs) direkt unter dem des Ursprungs. Darunter liegen
// beim obersten Ursprung auch die Partitionen seiner Frames, die zaehlen fuer sich.
uint64_t indexedDBUsage(const WebCore::ClientOrigin& origin)
{
    uint64_t usage = 0;
    for (auto version : { "v0"_s, "v1"_s }) {
        auto directory = WebCore::IDBDatabaseIdentifier::databaseDirectoryRelativeToRoot(origin, indexedDBDirectory, version);
        for (auto& name : FileSystem::listDirectory(directory))
            usage += memoryVFSDirectorySize(FileSystem::pathByAppendingComponent(directory, name));
    }
    return usage;
}

uint64_t directorySize(const String& directory)
{
    uint64_t total = 0;
    for (auto& name : FileSystem::listDirectory(directory)) {
        auto path = FileSystem::pathByAppendingComponent(directory, name);
        if (FileSystem::fileType(path) == FileSystem::FileType::Directory)
            total += directorySize(path);
        else
            total += FileSystem::fileSize(path).value_or(0);
    }
    return total;
}

FileReplacement::FileReplacement()
{
    static std::atomic<unsigned> counter;
    snprintf(m_temporary, sizeof(m_temporary), "%s/%u", temporaryDirectory.characters(), counter++);
    m_fd = open(m_temporary, O_WRONLY | O_CREAT | O_TRUNC, 0644);
    m_ok = m_fd >= 0;
}

FileReplacement::~FileReplacement()
{
    if (m_fd < 0)
        return;
    close(m_fd);
    unlink(m_temporary);
}

void FileReplacement::write(std::span<const uint8_t> data, uint64_t offset)
{
    for (size_t written = 0; m_ok && written < data.size();) {
        ssize_t length = pwrite(m_fd, data.data() + written, data.size() - written, offset + written);
        if (length < 0 && errno == EINTR)
            continue;
        m_ok = length > 0;
        if (m_ok)
            written += length;
    }
}

void FileReplacement::truncate(uint64_t size)
{
    m_ok = m_ok && !ftruncate(m_fd, size);
}

bool FileReplacement::commit(const char* path)
{
    if (m_fd < 0)
        return false;
    bool ok = !close(std::exchange(m_fd, -1)) && m_ok && !rename(m_temporary, path);
    if (!ok)
        unlink(m_temporary);
    return ok;
}

bool replaceWholeFile(const char* path, std::span<const uint8_t> data)
{
    FileReplacement file;
    file.write(data, 0);
    return file.commit(path);
}

ReadResult readWholeFile(const char* path, const ScopedLambda<bool(std::span<const uint8_t>)>& append)
{
    int fd = open(path, O_RDONLY);
    if (fd < 0)
        return errno == ENOENT ? ReadResult::Missing : ReadResult::Failed;
    uint8_t buffer[65536];
    ssize_t length;
    for (;;) {
        length = read(fd, buffer, sizeof(buffer));
        if (length < 0 && errno == EINTR)
            continue;
        if (length <= 0)
            break;
        if (!append(std::span<const uint8_t> { buffer, static_cast<size_t>(length) })) {
            length = -1;
            break;
        }
    }
    close(fd);
    return length < 0 ? ReadResult::Failed : ReadResult::Done;
}

ReadResult readWholeFile(const char* path, std::vector<uint8_t>& data)
{
    data.clear();
    struct stat info;
    if (!stat(path, &info) && info.st_size > 0)
        data.reserve(info.st_size);
    return readWholeFile(path, scopedLambda<bool(std::span<const uint8_t>)>([&](std::span<const uint8_t> chunk) {
        data.insert(data.end(), chunk.begin(), chunk.end());
        return true;
    }));
}

// OPFS mit synchronen Zugriffen gibt es nur in Workern eines Browsers (nicht in
// node). Laeuft im Engine-Thread.
EM_JS(int, blJsHasOPFS, (), {
    return typeof FileSystemSyncAccessHandle !== 'undefined' && !!(globalThis.navigator && navigator.storage && navigator.storage.getDirectory);
});

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
    if (!backend || wasmfs_create_directory("/data", 0777, backend))
        debugLog("Speicher: OPFS nicht verfuegbar, /data nur im Speicher");
}

void initializeStorage()
{
    mountDataDirectory();
    // Kopien von replaceWholeFile, deren Schreiben abgebrochen ist
    FileSystem::deleteNonEmptyDirectory(temporaryDirectory);
    FileSystem::makeAllDirectories(temporaryDirectory);
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
