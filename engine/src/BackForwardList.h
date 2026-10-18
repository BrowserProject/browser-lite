// Back/forward list of a view. The empty default client stores nothing.
#pragma once

#include <WebCore/BackForwardClient.h>
#include <WebCore/HistoryItem.h>
#include <wtf/Vector.h>

namespace BrowserLite {

class BackForwardList final : public WebCore::BackForwardClient {
public:
    static Ref<BackForwardList> create() { return adoptRef(*new BackForwardList); }

    // For the host's session: entries and current index, and putting them back
    // (when restoring and after discarding a view)
    const Vector<Ref<WebCore::HistoryItem>>& entries() const { return m_entries; }
    std::optional<size_t> currentIndex() const { return m_current; }
    void restore(Vector<Ref<WebCore::HistoryItem>>&& entries, size_t current)
    {
        m_entries = WTF::move(entries);
        m_current = current;
    }

    // For pushState from iframes (FrameLoaderClient::dispatchDidPushStateWithinPage)
    WebCore::HistoryItem* currentItem() const { return m_current ? m_entries[*m_current].ptr() : nullptr; }
    void replaceCurrentItem(Ref<WebCore::HistoryItem>&& item) { m_entries[*m_current] = WTF::move(item); }

private:
    void addItem(Ref<WebCore::HistoryItem>&&) final;
    void setChildItem(WebCore::BackForwardFrameItemIdentifier, Ref<WebCore::HistoryItem>&&) final;
    void goToItem(WebCore::HistoryItem&) final;
    Vector<Ref<WebCore::HistoryItem>> allItems(WebCore::FrameIdentifier) final { return m_entries; }
    RefPtr<WebCore::HistoryItem> itemAtIndex(int, WebCore::FrameIdentifier) final;
    unsigned backListCount() const final;
    unsigned forwardListCount() const final;
    bool containsItem(const WebCore::HistoryItem&) const final;
    void close() final;

    Vector<Ref<WebCore::HistoryItem>> m_entries;
    std::optional<size_t> m_current;
};

} // namespace BrowserLite
