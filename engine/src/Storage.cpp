// localStorage and IndexedDB come from WebKitLegacy/Storage (built with the
// engine, see engine.cmake): StorageNamespaceImpl/StorageAreaSync store
// localStorage in SQLite, InProcessIDBServer does IndexedDB with WebCore's
// SQLite backend.

#include "config.h"
#include "Storage.h"

#include "MemoryVFS.h"
#include "StorageTracker.h"
#include "WebDatabaseProvider.h"
#include "WebStorageNamespaceProvider.h"
#include "Engine.h"
#include "EngineConfig.h"
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
// Copies of FileReplacement and the uploads of the views, outside of
// /data/opfs where the pages choose the names. Emptied at start.
static constexpr auto temporaryDirectory = "/data/tmp"_s;

// In WebKitLegacy this is per platform (Mac: NSUserDefaults)
String WebDatabaseProvider::indexedDatabaseDirectoryPath()
{
    return indexedDBDirectory;
}

// IndexedDB limit per origin (patch 0040), computed like OriginQuotaManager in
// WebKit2: a reserve up to the limit, only when it is used up the usage is
// counted again (indexedDBUsage). Open databases live entirely in WASM memory
// (MemoryVFS.cpp), which has at most 4 GB and never shrinks. Opening, reading
// and deleting need no space, so a page at the limit gets to its data; the VFS
// does not load files that are too big (BL_DATABASE_MAX_MB). Runs on the
// IDBServer thread.
bool WebDatabaseProvider::requestIndexedDatabaseSpace(const WebCore::ClientOrigin& origin, uint64_t size)
{
    uint64_t quota = BrowserLite::indexedDBQuota();
    static NeverDestroyed<HashMap<WebCore::ClientOrigin, uint64_t>> remaining;
    auto& left = remaining->add(origin, 0).iterator->value;
    if (size > left) {
        uint64_t usage = BrowserLite::indexedDBUsage(origin);
        left = usage < quota ? quota - usage : 0;
        if (size > left)
            BrowserLite::log("IndexedDB: limit of %llu MB reached (%llu MB used)", static_cast<unsigned long long>(quota >> 20), static_cast<unsigned long long>(usage >> 20));
    }
    if (size > left)
        return false;
    left -= size;
    return true;
}

namespace BrowserLite {

uint64_t indexedDBQuota()
{
    return engineConfig().indexedDBQuotaMB << 20;
}

// Like SQLiteIDBBackingStore::databasesSizeForDirectory: one folder per
// database (with its blobs) directly under the origin's. Under it, the top
// origin also has the partitions of its frames, those count for themselves.
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

// OPFS with synchronous access only exists in workers of a browser (not in
// node). Runs on the engine thread.
EM_JS(int, blJsHasOPFS, (), {
    return typeof FileSystemSyncAccessHandle !== 'undefined' && !!(globalThis.navigator && navigator.storage && navigator.storage.getDirectory);
});

// /data persistent through the WasmFS OPFS backend, in the namespace directory
// of the OPFS root (engine/js/wasmfs-opfs.js). Accesses run through a WasmFS
// worker of their own, never through the UI thread. Without OPFS (node, old
// browsers) or with BL_OPFS=0 /data stays in memory.
static void mountDataDirectory()
{
    if (!engineConfig().opfs || !blJsHasOPFS()) {
        debugLog("Storage: /data in memory only (no OPFS)");
        return;
    }
    backend_t backend = wasmfs_create_opfs_backend();
    if (!backend || wasmfs_create_directory("/data", 0777, backend))
        debugLog("Storage: OPFS not available, /data in memory only");
}

void initializeStorage()
{
    mountDataDirectory();
    // Copies of replaceWholeFile whose writing was aborted
    FileSystem::deleteNonEmptyDirectory(temporaryDirectory);
    FileSystem::makeAllDirectories(temporaryDirectory);
    // SQLite databases under /data in WASM memory (MemoryVFS.cpp)
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
