// PlatformStrategies fuer single-process WebCore: Netzwerk, Clipboard, Blobs,
// Media. In WebKit2 machen das die anderen Prozesse ueber IPC, bei uns laeuft
// alles direkt im Engine-Thread. Blob-Registry wie WebKitLegacy (WebBlobRegistry)
// bzw. github.com/theogbob/WebkitWasm (BSD-2-Clause, Copyright (c) 2026 theogbob).

#include "config.h"
#include "Strategies.h"

#include "LoaderStrategy.h"

#include <WebCore/BlobDataFileReference.h>
#include <WebCore/BlobPart.h>
#include <WebCore/BlobRegistry.h>
#include <WebCore/BlobRegistryImpl.h>
#include <WebCore/Color.h>
#include <WebCore/CookieJarDB.h>
#include <WebCore/LoaderStrategy.h>
#include <WebCore/MediaStrategy.h>
#include <WebCore/NetworkStorageSession.h>
#include <WebCore/Pasteboard.h>
#include <WebCore/PasteboardItemInfo.h>
#include <WebCore/PasteboardStrategy.h>
#include <WebCore/PlatformPasteboard.h>
#include <WebCore/PlatformStrategies.h>
#include <WebCore/PolicyContainer.h>
#include <WebCore/SharedBuffer.h>
#include <pal/SessionID.h>
#include <wtf/NeverDestroyed.h>

namespace BrowserLite {

using namespace WebCore;

NetworkStorageSession& networkStorageSession()
{
    // Cookies in SQLite unter /data (spaeter OPFS, Phase 7). Bis dahin im Speicher.
    static NeverDestroyed<std::unique_ptr<NetworkStorageSession>> session = [] {
        auto session = makeUnique<NetworkStorageSession>(PAL::SessionID::defaultSessionID(), String { });
        session->setCookieDatabase(makeUniqueRef<CookieJarDB>(":memory:"_s));
        return session;
    }();
    return *session.get();
}

class WasmBlobRegistry final : public BlobRegistry {
    void registerInternalFileBlobURL(const URL& url, Ref<BlobDataFileReference>&& file, const String&, const String& contentType) final
    {
        m_impl.registerInternalFileBlobURL(url, WTF::move(file), contentType);
    }
    void registerInternalBlobURL(const URL& url, Vector<BlobPart>&& parts, const String& contentType) final
    {
        m_impl.registerInternalBlobURL(url, WTF::move(parts), contentType);
    }
    void registerBlobURL(const URL& url, const URL& srcURL, const PolicyContainer& policyContainer, const std::optional<SecurityOriginData>& topOrigin) final
    {
        m_impl.registerBlobURL(url, srcURL, policyContainer, topOrigin);
    }
    void registerInternalBlobURLOptionallyFileBacked(const URL& url, const URL& srcURL, RefPtr<BlobDataFileReference>&& file, const String& contentType) final
    {
        m_impl.registerInternalBlobURLOptionallyFileBacked(url, srcURL, WTF::move(file), contentType, { });
    }
    void registerInternalBlobURLForSlice(const URL& url, const URL& srcURL, long long start, long long end, const String& contentType) final
    {
        m_impl.registerInternalBlobURLForSlice(url, srcURL, start, end, contentType);
    }
    void unregisterBlobURL(const URL& url, const std::optional<SecurityOriginData>& topOrigin) final
    {
        m_impl.unregisterBlobURL(url, topOrigin);
    }
    void registerBlobURLHandle(const URL& url, const std::optional<SecurityOriginData>& topOrigin) final
    {
        m_impl.registerBlobURLHandle(url, topOrigin);
    }
    void unregisterBlobURLHandle(const URL& url, const std::optional<SecurityOriginData>& topOrigin) final
    {
        m_impl.unregisterBlobURLHandle(url, topOrigin);
    }
    String blobType(const URL& url) final { return m_impl.blobType(url); }
    unsigned long long blobSize(const URL& url) final { return m_impl.blobSize(url); }
    void writeBlobsToTemporaryFilesForIndexedDB(const Vector<String>& blobURLs, CompletionHandler<void(Vector<String>&&)>&& completion) final
    {
        m_impl.writeBlobsToTemporaryFilesForIndexedDB(blobURLs, WTF::move(completion));
    }
    BlobRegistryImpl* blobRegistryImpl() final { return &m_impl; }

    BlobRegistryImpl m_impl;
};

// Clipboard: direkt an PlatformPasteboard (platform/wasm/PlatformPasteboardWasm.cpp)
class WasmPasteboardStrategy final : public PasteboardStrategy {
    String readStringFromPasteboard(size_t index, const String& type, const String& name, const PasteboardContext*) final
    {
        return PlatformPasteboard(name).readString(index, type);
    }
    RefPtr<SharedBuffer> readBufferFromPasteboard(std::optional<size_t>, const String&, const String&, const PasteboardContext*) final { return nullptr; }
    URL readURLFromPasteboard(size_t, const String&, String&, const PasteboardContext*) final { return { }; }
    std::optional<PasteboardItemInfo> informationForItemAtIndex(size_t, const String&, int64_t, const PasteboardContext*) final { return std::nullopt; }
    std::optional<Vector<PasteboardItemInfo>> allPasteboardItemInfo(const String&, int64_t, const PasteboardContext*) final { return std::nullopt; }
    int getPasteboardItemsCount(const String&, const PasteboardContext*) final { return 1; }
    Vector<String> typesSafeForDOMToReadAndWrite(const String& name, const String& origin, const PasteboardContext*) final
    {
        return PlatformPasteboard(name).typesSafeForDOMToReadAndWrite(origin);
    }
    int64_t writeCustomData(const Vector<PasteboardCustomData>& data, const String& name, const PasteboardContext*) final
    {
        return PlatformPasteboard(name).write(data);
    }
    bool containsStringSafeForDOMToReadForType(const String&, const String&, const PasteboardContext*) final { return false; }
    void getTypes(Vector<String>& types) final
    {
        PlatformPasteboard().getTypes(types);
    }
    void writeToPasteboard(const PasteboardWebContent& content) final
    {
        PlatformPasteboard().write(content);
    }
    void writeToPasteboard(const String& type, const String& text) final
    {
        PlatformPasteboard().write(type, text);
    }
};

class WasmMediaStrategy final : public MediaStrategy {
    // VIDEO und WEB_AUDIO sind (noch) aus, es gibt nichts zu implementieren.
};

class WasmPlatformStrategies final : public PlatformStrategies {
    WebCore::LoaderStrategy* createLoaderStrategy() final { return &BrowserLite::loaderStrategy(); }
    PasteboardStrategy* createPasteboardStrategy() final
    {
        static NeverDestroyed<WasmPasteboardStrategy> strategy;
        return &strategy.get();
    }
    MediaStrategy* createMediaStrategy() final
    {
        static NeverDestroyed<WasmMediaStrategy> strategy;
        return &strategy.get();
    }
    BlobRegistry* createBlobRegistry() final
    {
        static NeverDestroyed<WasmBlobRegistry> registry;
        return &registry.get();
    }
};

void installPlatformStrategies()
{
    static NeverDestroyed<WasmPlatformStrategies> strategies;
    setPlatformStrategies(&strategies.get());
}

} // namespace BrowserLite
