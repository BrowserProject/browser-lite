// Storage of the pages: cookies, localStorage and IndexedDB live under /data.
// /data is the namespace directory in the OPFS of the host browser
// (BL_STORAGE_NAMESPACE, Storage.cpp), so everything survives a reload.
// Without OPFS (node tests, BL_OPFS=0) /data is in memory only.
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

// IndexedDB limit per origin (BL_INDEXEDDB_QUOTA_MB, otherwise 256 MB) and the
// space the databases of an origin use for it
uint64_t indexedDBQuota();
uint64_t indexedDBUsage(const WebCore::ClientOrigin&);
// All files under directory on disk
uint64_t directorySize(const String& directory);

// Replace whole files under /data (databases, Cache API): first write a copy
// to /data/tmp, then rename. If writing breaks off (view closed, disk full),
// the old file stays complete (initializeStorage empties /data/tmp on the next
// start).
class FileReplacement {
public:
    FileReplacement();
    ~FileReplacement();
    FileReplacement(const FileReplacement&) = delete;
    FileReplacement& operator=(const FileReplacement&) = delete;

    // Write at a position of the copy or set its length
    void write(std::span<const uint8_t>, uint64_t offset);
    void truncate(uint64_t size);
    // false: something already went wrong while writing
    bool ok() const { return m_fd >= 0 && m_ok; }
    // The copy replaces path. false: something went wrong, path is as before
    bool commit(const char* path);

private:
    char m_temporary[64];
    int m_fd { -1 };
    bool m_ok { true };
};

bool replaceWholeFile(const char* path, std::span<const uint8_t>);

// Only "does not exist" is Missing. Every other error (e.g. the OPFS is taken
// by another tab) is Failed, so nobody writes an empty file over the real
// one.
enum class ReadResult : uint8_t { Done, Missing, Failed };
ReadResult readWholeFile(const char* path, std::vector<uint8_t>&);
// In pieces, without everything in memory at once. append false: Failed
ReadResult readWholeFile(const char* path, const ScopedLambda<bool(std::span<const uint8_t>)>& append);

} // namespace BrowserLite
