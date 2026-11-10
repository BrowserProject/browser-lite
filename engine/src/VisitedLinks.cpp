// :visited needs a VisitedLinkStore on every page: WebCore's empty one of the
// page configuration answers "not visited" for every link. Like the stores of
// WebKitLegacy and WebKit2 this one keeps the shared string hashes of the
// visited addresses, not the addresses. WebCore itself limits what :visited
// may change (colors) and what scripts can read of it.

#include "config.h"
#include "VisitedLinks.h"

#include <WebCore/SharedStringHash.h>
#include <WebCore/VisitedLinkStore.h>
#include <wtf/HashSet.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/URL.h>

namespace BrowserLite {

using namespace WebCore;

namespace {

class VisitedLinkStoreWasm final : public VisitedLinkStore {
public:
    static Ref<VisitedLinkStoreWasm> create() { return adoptRef(*new VisitedLinkStoreWasm); }

    bool isLinkVisited(Page&, SharedStringHash hash, const URL&, const AtomString&) final
    {
        return m_hashes.contains(hash);
    }

    // Every address a frame of a page commits (HistoryController)
    void addVisitedLink(Page&, SharedStringHash hash) final { add(hash); }

    void add(SharedStringHash hash)
    {
        // 0 is the hash of a link to the document itself, which WebCore counts as visited anyway
        if (!decltype(m_hashes)::isValidValue(hash))
            return;
        // Only the documents that styled a link to this address restyle it
        if (m_hashes.add(hash).isNewEntry)
            invalidateStylesForLink(hash);
    }

    void clear()
    {
        if (m_hashes.isEmpty())
            return;
        m_hashes.clear();
        invalidateStylesForAllLinks();
    }

private:
    HashSet<SharedStringHash, SharedStringHashHash> m_hashes;
};

VisitedLinkStoreWasm& store()
{
    static NeverDestroyed<Ref<VisitedLinkStoreWasm>> store { VisitedLinkStoreWasm::create() };
    return store.get();
}

} // namespace

VisitedLinkStore& visitedLinkStore()
{
    return store();
}

void addVisitedLinks(const String& urls)
{
    for (auto line : StringView(urls).split('\n')) {
        // The string WebCore's history hashes: the parsed address
        URL url { line.trim(isASCIIWhitespace<char16_t>).toString() };
        if (url.isValid())
            store().add(computeSharedStringHash(url.string()));
    }
}

void clearVisitedLinks()
{
    store().clear();
}

} // namespace BrowserLite
