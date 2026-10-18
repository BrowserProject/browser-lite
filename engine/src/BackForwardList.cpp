#include "config.h"
#include "BackForwardList.h"

namespace BrowserLite {

using namespace WebCore;

static constexpr size_t capacity = 100;

void BackForwardList::addItem(Ref<HistoryItem>&& item)
{
    // Everything after the current entry goes away (new navigation)
    if (m_current)
        m_entries.shrink(*m_current + 1);
    else
        m_entries.clear();
    m_entries.append(WTF::move(item));
    if (m_entries.size() > capacity)
        m_entries.removeAt(0);
    m_current = m_entries.size() - 1;
}

static HistoryItem* findItem(HistoryItem& item, BackForwardFrameItemIdentifier frameItemID)
{
    if (item.frameItemID() == frameItemID)
        return &item;
    for (auto& child : item.children()) {
        if (auto* found = findItem(child.get(), frameItemID))
            return found;
    }
    return nullptr;
}

void BackForwardList::setChildItem(BackForwardFrameItemIdentifier frameItemID, Ref<HistoryItem>&& item)
{
    // A subframe navigated: replace the matching part of the current entry
    if (!m_current)
        return;
    if (auto* parent = findItem(m_entries[*m_current].get(), frameItemID))
        parent->setChildItem(WTF::move(item));
}

void BackForwardList::goToItem(HistoryItem& item)
{
    for (size_t i = 0; i < m_entries.size(); ++i) {
        if (m_entries[i].ptr() == &item) {
            m_current = i;
            return;
        }
    }
}

RefPtr<HistoryItem> BackForwardList::itemAtIndex(int offset, FrameIdentifier)
{
    if (!m_current)
        return nullptr;
    int index = static_cast<int>(*m_current) + offset;
    if (index < 0 || index >= static_cast<int>(m_entries.size()))
        return nullptr;
    return m_entries[index].ptr();
}

unsigned BackForwardList::backListCount() const
{
    return m_current ? *m_current : 0;
}

unsigned BackForwardList::forwardListCount() const
{
    return m_current ? m_entries.size() - *m_current - 1 : 0;
}

bool BackForwardList::containsItem(const HistoryItem& item) const
{
    return m_entries.containsIf([&](auto& entry) { return entry.ptr() == &item; });
}

void BackForwardList::close()
{
    m_entries.clear();
    m_current = std::nullopt;
}

} // namespace BrowserLite
