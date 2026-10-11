// Verlauf (Zurueck/Vor) eines Tabs. Der leere Standard-Client speichert nichts.
#pragma once

#include <WebCore/BackForwardClient.h>
#include <WebCore/HistoryItem.h>
#include <wtf/Vector.h>

namespace BrowserLite {

class BackForwardList final : public WebCore::BackForwardClient {
public:
    static Ref<BackForwardList> create() { return adoptRef(*new BackForwardList); }

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
