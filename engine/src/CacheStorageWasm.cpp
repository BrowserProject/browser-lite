// Cache API (caches.open, cache.put/match ...) for pages and workers.
//
// In WebKit2 the implementation lives in the network process
// (CacheStorageManager). Here a small one of our own in the engine, shared by
// all views, separated by origin. Persistent under /data/cachestorage (like
// everything under /data in the host's OPFS): per origin one file with the
// entries without bodies, read on the first access and replaced as a whole,
// batched, after changes, and one file per body in the folder "<file>.bodies".
// cache.put writes the bodies right away, they do not stay in memory, match
// reads them again. If writing fails, the body stays in memory until the next
// attempt. The entry format is the one of WebKit's CacheStorageDiskStore.
//
// Every origin has a fixed limit (maximumOriginSize, all share the host's
// OPFS), above it cache.put rejects with QuotaExceededError.
#include "config.h"
#include "CacheStorageWasm.h"

#include "Engine.h"
#include "Storage.h"

#include <WebCore/DOMCacheEngine.h>

// NativePromise copies values for other threads; the result of open() is only
// an identifier and a bool, a shallow copy is enough
namespace WTF {
template<> struct CrossThreadCopierBase<false, false, WebCore::DOMCacheEngine::CacheIdentifierOperationResult> {
    using Type = WebCore::DOMCacheEngine::CacheIdentifierOperationResult;
    static constexpr bool IsNeeded = false;
    static Type copy(const Type& value) { return value; }
};
}

#include <WebCore/CacheQueryOptions.h>
#include <WebCore/CacheStorageConnection.h>
#include <WebCore/CacheStorageProvider.h>
#include <WebCore/ClientOrigin.h>
#include <WebCore/DOMCacheEngine.h>
#include <WebCore/FetchHeaders.h>
#include <WebCore/FormData.h>
#include <WebCore/RetrieveRecordsOptions.h>
#include <WebCore/SharedBuffer.h>
#include <WebCore/WebCorePersistentCoders.h>
#include <wtf/FileSystem.h>
#include <wtf/HashMap.h>
#include <wtf/HashSet.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/RunLoop.h>
#include <wtf/UUID.h>
#include <wtf/persistence/PersistentDecoder.h>
#include <wtf/persistence/PersistentEncoder.h>
#include <wtf/text/MakeString.h>

namespace BrowserLite {

using namespace WebCore;
using namespace WebCore::DOMCacheEngine;

// An entry. The body is in bodyFile (name in the origin's folder), empty
// means: no body, an empty one, or it is not written yet (then in
// data.responseBody)
struct StoredRecord {
    CrossThreadRecord data;
    String bodyFile;
};

static bool matches(const ResourceRequest& request, const StoredRecord& record, const CacheQueryOptions& options)
{
    auto response = ResourceResponse::fromCrossThreadData(record.data.response.isolatedCopy());
    return queryCacheMatch(request, record.data.request, response, options);
}

static bool isEmptyBody(const ResponseBody& body)
{
    return WTF::switchOn(body, [](const Ref<FormData>& formData) {
        return formData->isEmpty();
    }, [](const Ref<SharedBuffer>& buffer) {
        return buffer->isEmpty();
    }, [](const std::nullptr_t&) {
        return true;
    });
}

// Body in memory that still has to go into a file
static bool hasUnstoredBody(const StoredRecord& record)
{
    return record.bodyFile.isEmpty() && !isEmptyBody(record.data.responseBody);
}

static constexpr uint32_t fileVersion = 2;
static constexpr uint64_t maximumOriginSize = 256 << 20;
static constexpr auto storageDirectory = "/data/cachestorage"_s;
static constexpr Seconds writeDelay = 500_ms;
static constexpr Seconds retryDelay = 10_s;

static String fileForOrigin(const ClientOrigin& origin)
{
    return FileSystem::pathByAppendingComponent(storageDirectory, FileSystem::encodeForFileName(makeString(origin.topOrigin.toString(), ' ', origin.clientOrigin.toString())));
}

static String bodyDirectory(const ClientOrigin& origin)
{
    return makeString(fileForOrigin(origin), ".bodies"_s);
}

static String bodyPath(const ClientOrigin& origin, const String& bodyFile)
{
    return FileSystem::pathByAppendingComponent(bodyDirectory(origin), bodyFile);
}

// Form data with files/blobs is not stored by WebKit either
static bool writeBody(const String& path, const ResponseBody& body)
{
    return WTF::switchOn(body, [&](const Ref<FormData>& formData) {
        return replaceWholeFile(path.utf8().data(), formData->flatten().span());
    }, [&](const Ref<SharedBuffer>& buffer) {
        return replaceWholeFile(path.utf8().data(), buffer->span());
    }, [](const std::nullptr_t&) {
        return true;
    });
}

// Only after storeBody: a body in memory is not included
static void encodeRecord(WTF::Persistence::Encoder& encoder, const StoredRecord& record)
{
    auto& data = record.data;
    encoder << static_cast<uint8_t>(data.requestHeadersGuard);
    encoder << data.request;
    data.options.encodePersistent(encoder);
    encoder << data.referrer;
    encoder << static_cast<uint8_t>(data.responseHeadersGuard);
    encoder << data.response;
    bool hasBody = !record.bodyFile.isEmpty() || !std::holds_alternative<std::nullptr_t>(data.responseBody);
    encoder << hasBody;
    encoder << record.bodyFile;
    encoder << data.responseBodySize;
}

static std::optional<StoredRecord> decodeRecord(WTF::Persistence::Decoder& decoder)
{
    std::optional<uint8_t> requestGuard;
    decoder >> requestGuard;
    std::optional<ResourceRequest> request;
    decoder >> request;
    FetchOptions options;
    if (!requestGuard || !request || !FetchOptions::decodePersistent(decoder, options))
        return std::nullopt;
    std::optional<String> referrer;
    decoder >> referrer;
    std::optional<uint8_t> responseGuard;
    decoder >> responseGuard;
    std::optional<ResourceResponse::CrossThreadData> response;
    decoder >> response;
    std::optional<bool> hasBody;
    decoder >> hasBody;
    std::optional<String> bodyFile;
    decoder >> bodyFile;
    std::optional<uint64_t> bodySize;
    decoder >> bodySize;
    if (!referrer || !responseGuard || !response || !hasBody || !bodyFile || !bodySize)
        return std::nullopt;
    ResponseBody responseBody = nullptr;
    if (*hasBody && bodyFile->isEmpty())
        responseBody = SharedBuffer::create();
    return StoredRecord { CrossThreadRecord { 0, 0, static_cast<FetchHeaders::Guard>(*requestGuard), WTF::move(*request), WTF::move(options), WTF::move(*referrer),
        static_cast<FetchHeaders::Guard>(*responseGuard), WTF::move(*response), WTF::move(responseBody), *bodySize }, WTF::move(*bodyFile) };
}

class CacheStorageConnectionWasm final : public CacheStorageConnection {
public:
    static CacheStorageConnectionWasm& singleton()
    {
        static NeverDestroyed<Ref<CacheStorageConnectionWasm>> connection = adoptRef(*new CacheStorageConnectionWasm);
        return connection.get();
    }

private:
    struct Cache {
        String name;
        ClientOrigin origin;
        Vector<StoredRecord> records;
    };

    // Reads the origin's stored caches on the first access. If reading fails,
    // the origin is not written in this session, so the files on disk stay
    void ensureLoaded(const ClientOrigin& origin)
    {
        if (!m_loadedOrigins.add(origin).isNewEntry)
            return;
        auto file = fileForOrigin(origin);
        std::vector<uint8_t> data;
        auto result = readWholeFile(file.utf8().data(), data);
        if (result == ReadResult::Failed) {
            debugLog("Cache API: %s not readable, changes stay in memory only", file.utf8().data());
            m_unreadableOrigins.add(origin);
            return;
        }
        if (result == ReadResult::Done)
            decode(origin, std::span<const uint8_t> { data });
        deleteUnusedBodies(origin);
    }

    void decode(const ClientOrigin& origin, std::span<const uint8_t> data)
    {
        WTF::Persistence::Decoder decoder(data);
        std::optional<uint32_t> version;
        decoder >> version;
        std::optional<uint64_t> cacheCount;
        decoder >> cacheCount;
        if (version != fileVersion || !cacheCount)
            return;
        for (uint64_t i = 0; i < *cacheCount; ++i) {
            std::optional<String> name;
            decoder >> name;
            std::optional<uint64_t> recordCount;
            decoder >> recordCount;
            if (!name || !recordCount)
                return;
            Cache cache { *name, origin, { } };
            for (uint64_t j = 0; j < *recordCount; ++j) {
                auto record = decodeRecord(decoder);
                if (!record)
                    return;
                record->data.identifier = ++m_nextRecordIdentifier;
                originSize(origin) += record->data.responseBodySize;
                cache.records.append(WTF::move(*record));
            }
            auto identifier = DOMCacheIdentifier::generate();
            m_caches.add(identifier, WTF::move(cache));
            m_order.append(identifier);
            // The pages remember the list of caches until the next change
            ++m_updateCounter;
        }
    }

    // Bodies without an entry (aborted between writing the body and writing
    // the origin's file)
    void deleteUnusedBodies(const ClientOrigin& origin)
    {
        HashSet<String> used;
        for (auto& cache : m_caches.values()) {
            if (cache.origin != origin)
                continue;
            for (auto& record : cache.records) {
                if (!record.bodyFile.isEmpty())
                    used.add(record.bodyFile);
            }
        }
        auto directory = bodyDirectory(origin);
        for (auto& name : FileSystem::listDirectory(directory)) {
            if (!used.contains(name))
                FileSystem::deleteFile(FileSystem::pathByAppendingComponent(directory, name));
        }
    }

    // Body into its own file, afterwards it is no longer in memory
    bool storeBody(const ClientOrigin& origin, StoredRecord& record)
    {
        if (!hasUnstoredBody(record))
            return true;
        auto name = createVersion4UUIDString();
        FileSystem::makeAllDirectories(bodyDirectory(origin));
        if (!writeBody(bodyPath(origin, name), record.data.responseBody))
            return false;
        record.bodyFile = WTF::move(name);
        record.data.responseBody = nullptr;
        return true;
    }

    // nullopt: the file is not readable
    static std::optional<ResponseBody> readBody(const ClientOrigin& origin, const StoredRecord& record)
    {
        if (record.bodyFile.isEmpty())
            return copyResponseBody(record.data.responseBody);
        auto data = FileSystem::readEntireFile(bodyPath(origin, record.bodyFile));
        if (!data)
            return std::nullopt;
        return ResponseBody { SharedBuffer::create(WTF::move(*data)) };
    }

    // The entry is gone; delete its file only once the origin's file is
    // written without it
    void forget(const ClientOrigin& origin, const StoredRecord& record)
    {
        auto& size = originSize(origin);
        size -= std::min(size, record.data.responseBodySize);
        if (!record.bodyFile.isEmpty())
            m_unusedBodies.add(origin, Vector<String> { }).iterator->value.append(record.bodyFile);
    }

    // After a change: collect briefly, then write the origin's file
    void markChanged(const ClientOrigin& origin)
    {
        m_changedOrigins.add(origin);
        scheduleWrite(writeDelay);
    }

    void scheduleWrite(Seconds delay)
    {
        if (std::exchange(m_writeScheduled, true))
            return;
        RunLoop::mainSingleton().dispatchAfter(delay, [this] {
            m_writeScheduled = false;
            bool failed = false;
            for (auto& origin : std::exchange(m_changedOrigins, { })) {
                if (!write(origin)) {
                    m_changedOrigins.add(origin);
                    failed = true;
                }
            }
            if (failed)
                scheduleWrite(retryDelay);
        });
    }

    bool write(const ClientOrigin& origin)
    {
        if (m_unreadableOrigins.contains(origin))
            return true;
        Vector<Cache*> caches;
        for (auto identifier : m_order) {
            auto it = m_caches.find(identifier);
            if (it != m_caches.end() && it->value.origin == origin)
                caches.append(&it->value);
        }
        auto file = fileForOrigin(origin);
        bool written;
        if (caches.isEmpty())
            written = FileSystem::deleteFile(file) || !FileSystem::fileExists(file);
        else {
            WTF::Persistence::Encoder encoder;
            encoder << fileVersion;
            encoder << static_cast<uint64_t>(caches.size());
            for (auto* cache : caches) {
                encoder << cache->name;
                encoder << static_cast<uint64_t>(cache->records.size());
                for (auto& record : cache->records) {
                    if (!storeBody(origin, record))
                        return false;
                    encodeRecord(encoder, record);
                }
            }
            FileSystem::makeAllDirectories(storageDirectory);
            written = replaceWholeFile(file.utf8().data(), encoder.span());
        }
        if (!written) {
            debugLog("Cache API: %s not written, retrying later", file.utf8().data());
            return false;
        }
        for (auto& name : m_unusedBodies.take(origin))
            FileSystem::deleteFile(bodyPath(origin, name));
        if (caches.isEmpty())
            FileSystem::deleteEmptyDirectory(bodyDirectory(origin));
        return true;
    }

    uint64_t& originSize(const ClientOrigin& origin)
    {
        return m_originSizes.add(origin, 0).iterator->value;
    }

    Ref<OpenPromise> open(const ClientOrigin& origin, const String& name) final
    {
        ensureLoaded(origin);
        for (auto& [identifier, cache] : m_caches) {
            if (cache.origin == origin && cache.name == name)
                return OpenPromise::createAndResolve(CacheIdentifierOperationResult { identifier, false });
        }
        auto identifier = DOMCacheIdentifier::generate();
        m_caches.add(identifier, Cache { name, origin, { } });
        m_order.append(identifier);
        ++m_updateCounter;
        markChanged(origin);
        return OpenPromise::createAndResolve(CacheIdentifierOperationResult { identifier, false });
    }

    Ref<RemovePromise> remove(DOMCacheIdentifier identifier) final
    {
        auto it = m_caches.find(identifier);
        bool removed = it != m_caches.end();
        if (removed) {
            auto origin = it->value.origin;
            for (auto& record : it->value.records)
                forget(origin, record);
            m_caches.remove(it);
            ++m_updateCounter;
            markChanged(origin);
        }
        m_order.removeFirst(identifier);
        return RemovePromise::createAndResolve(removed);
    }

    Ref<RetrieveCachesPromise> retrieveCaches(const ClientOrigin& origin, uint64_t) final
    {
        ensureLoaded(origin);
        CacheInfos result { { }, m_updateCounter };
        for (auto identifier : m_order) {
            auto it = m_caches.find(identifier);
            if (it != m_caches.end() && it->value.origin == origin)
                result.infos.append(CacheInfo { identifier, it->value.name });
        }
        return RetrieveCachesPromise::createAndResolve(WTF::move(result));
    }

    Ref<RetrieveRecordsPromise> retrieveRecords(DOMCacheIdentifier identifier, RetrieveRecordsOptions&& options) final
    {
        auto it = m_caches.find(identifier);
        if (it == m_caches.end())
            return RetrieveRecordsPromise::createAndReject(Error::Internal);
        CacheQueryOptions query { options.ignoreSearch, options.ignoreMethod, options.ignoreVary };
        Vector<CrossThreadRecord> result;
        for (auto& record : it->value.records) {
            if (!options.request.url().isNull() && !matches(options.request, record, query))
                continue;
            ResponseBody body = nullptr;
            if (options.shouldProvideResponse) {
                auto stored = readBody(it->value.origin, record);
                if (!stored) {
                    debugLog("Cache API: body %s not readable", record.bodyFile.utf8().data());
                    return RetrieveRecordsPromise::createAndReject(Error::ReadDisk);
                }
                body = WTF::move(*stored);
            }
            auto& data = record.data;
            result.append(CrossThreadRecord { data.identifier, data.updateResponseCounter, data.requestHeadersGuard, ResourceRequest { data.request },
                data.options, String { data.referrer }, data.responseHeadersGuard, data.response.isolatedCopy(), WTF::move(body), data.responseBodySize });
        }
        return RetrieveRecordsPromise::createAndResolve(WTF::move(result));
    }

    Ref<BatchPromise> batchDeleteOperation(DOMCacheIdentifier identifier, const ResourceRequest& request, CacheQueryOptions&& options) final
    {
        auto it = m_caches.find(identifier);
        if (it == m_caches.end())
            return BatchPromise::createAndReject(Error::Internal);
        Vector<uint64_t> removed;
        auto& origin = it->value.origin;
        it->value.records.removeAllMatching([&](auto& record) {
            if (!matches(request, record, options))
                return false;
            removed.append(record.data.identifier);
            forget(origin, record);
            return true;
        });
        if (!removed.isEmpty())
            markChanged(origin);
        return BatchPromise::createAndResolve(WTF::move(removed));
    }

    Ref<BatchPromise> batchPutOperation(DOMCacheIdentifier identifier, Vector<CrossThreadRecord>&& records) final
    {
        auto it = m_caches.find(identifier);
        if (it == m_caches.end())
            return BatchPromise::createAndReject(Error::Internal);
        auto& stored = it->value.records;
        auto& origin = it->value.origin;
        // Check first, then change: put/addAll succeeds completely or not at all
        uint64_t newSize = originSize(origin);
        HashSet<uint64_t> replaced;
        for (auto& record : records) {
            newSize += record.responseBodySize;
            for (auto& existing : stored) {
                if (matches(record.request, existing, { }) && replaced.add(existing.data.identifier).isNewEntry)
                    newSize -= std::min(newSize, existing.data.responseBodySize);
            }
        }
        if (newSize > maximumOriginSize)
            return BatchPromise::createAndReject(Error::QuotaExceeded);
        Vector<uint64_t> identifiers;
        for (auto& record : records) {
            // The same request replaces the old entry (Cache.put)
            stored.removeAllMatching([&](auto& existing) {
                if (!matches(record.request, existing, { }))
                    return false;
                forget(origin, existing);
                return true;
            });
            record.identifier = ++m_nextRecordIdentifier;
            record.updateResponseCounter = 0;
            identifiers.append(record.identifier);
            originSize(origin) += record.responseBodySize;
            StoredRecord entry { WTF::move(record), { } };
            if (!m_unreadableOrigins.contains(origin))
                storeBody(origin, entry);
            stored.append(WTF::move(entry));
        }
        markChanged(origin);
        return BatchPromise::createAndResolve(WTF::move(identifiers));
    }

    void reference(DOMCacheIdentifier) final { }
    void dereference(DOMCacheIdentifier) final { }
    void lockStorage(const ClientOrigin&) final { }
    void unlockStorage(const ClientOrigin&) final { }

    HashMap<DOMCacheIdentifier, Cache> m_caches;
    Vector<DOMCacheIdentifier> m_order;
    HashSet<ClientOrigin> m_loadedOrigins;
    HashSet<ClientOrigin> m_changedOrigins;
    HashSet<ClientOrigin> m_unreadableOrigins;
    HashMap<ClientOrigin, uint64_t> m_originSizes;
    HashMap<ClientOrigin, Vector<String>> m_unusedBodies;
    bool m_writeScheduled { false };
    uint64_t m_updateCounter { 0 };
    uint64_t m_nextRecordIdentifier { 0 };
};

class CacheStorageProviderWasm final : public CacheStorageProvider {
public:
    static Ref<CacheStorageProviderWasm> create() { return adoptRef(*new CacheStorageProviderWasm); }
    Ref<CacheStorageConnection> createCacheStorageConnection() final { return CacheStorageConnectionWasm::singleton(); }
};

Ref<CacheStorageProvider> createCacheStorageProvider()
{
    return CacheStorageProviderWasm::create();
}

uint64_t cacheStorageUsage(const ClientOrigin& origin)
{
    return FileSystem::fileSize(fileForOrigin(origin)).value_or(0) + directorySize(bodyDirectory(origin));
}

} // namespace BrowserLite
