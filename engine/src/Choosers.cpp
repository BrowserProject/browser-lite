#include "config.h"
#include "Choosers.h"

#include "Host.h"
#include "WebView.h"
#include <WebCore/Color.h>
#include <WebCore/ColorChooserClient.h>
#include <WebCore/ColorSerialization.h>
#include <WebCore/DateTimeChooserClient.h>
#include <WebCore/DateTimeChooserParameters.h>
#include <WebCore/LocalFrameView.h>
#include <WebCore/PopupMenuClient.h>
#include <cmath>
#include <wtf/HashMap.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/text/MakeString.h>
#include <wtf/TZoneMallocInlines.h>
#include <wtf/text/StringBuilder.h>
#include <wtf/text/StringToIntegerConversion.h>

using namespace WebCore;

namespace BrowserLite {

static String rectJSON(const IntRect& rect)
{
    return makeString("\"x\":"_s, rect.x(), ",\"y\":"_s, rect.y(), ",\"width\":"_s, rect.width(), ",\"height\":"_s, rect.height());
}

class PopupMenuWasm;
class ColorChooserWasm;
class DateTimeChooserWasm;

// At most one open chooser of each kind per view
template<typename T> static HashMap<int, RefPtr<T>>& openChoosers()
{
    static NeverDestroyed<HashMap<int, RefPtr<T>>> choosers;
    return choosers;
}

template<typename T> static void forgetChooser(int viewId, T& chooser)
{
    auto& map = openChoosers<T>();
    auto it = map.find(viewId);
    if (it != map.end() && it->value.get() == &chooser)
        map.remove(it);
}

// List of a <select> (also <input list>, <input type=search>)
class PopupMenuWasm final : public PopupMenu {
public:
    static Ref<PopupMenuWasm> create(WebView& view, PopupMenuClient& client) { return adoptRef(*new PopupMenuWasm(view, client)); }

    void choose(int index)
    {
        Ref protectedThis { *this };
        m_shown = false;
        if (!m_client)
            return;
        if (index >= 0 && index < m_client->listSize())
            m_client->valueChanged(index);
        if (m_client)
            m_client->popupDidHide();
    }

private:
    PopupMenuWasm(WebView& view, PopupMenuClient& client)
        : m_viewId(view.id())
        , m_client(&client)
    {
    }

    void show(const IntRect& rect, LocalFrameView& view, int selectedIndex) final
    {
        if (!m_client)
            return;
        m_shown = true;
        m_rect = view.contentsToRootView(rect);
        m_selectedIndex = selectedIndex;
        send();
    }

    void hide() final
    {
        if (!m_shown)
            return;
        m_shown = false;
        Ref protectedThis { *this };
        forgetChooser(m_viewId, *this);
        notifyHost(m_viewId, "popup-hide");
    }

    void updateFromElement() final
    {
        if (m_shown && m_client)
            send();
    }

    void disconnectClient() final
    {
        m_client = nullptr;
        hide();
    }

    void send();

    int m_viewId;
    PopupMenuClient* m_client;
    IntRect m_rect;
    int m_selectedIndex { -1 };
    bool m_shown { false };
};

void PopupMenuWasm::send()
{
    openChoosers<PopupMenuWasm>().set(m_viewId, this);
    auto& client = *m_client;
    StringBuilder items;
    int size = client.listSize();
    for (int i = 0; i < size; i++) {
        if (i)
            items.append(',');
        if (client.itemIsSeparator(i)) {
            items.append("{\"separator\":true}"_s);
            continue;
        }
        items.append("{\"text\":\""_s, jsonEscape(client.itemText(i)), "\",\"tooltip\":\""_s, jsonEscape(client.itemToolTip(i)),
            "\",\"enabled\":"_s, client.itemIsEnabled(i) ? "true"_s : "false"_s,
            ",\"label\":"_s, client.itemIsLabel(i) ? "true"_s : "false"_s,
            ",\"selected\":"_s, client.itemIsSelected(i) ? "true"_s : "false"_s, '}');
    }
    notifyHost(m_viewId, "popup", makeString('{', rectJSON(m_rect), ",\"selectedIndex\":"_s, m_selectedIndex,
        ",\"items\":["_s, items.toString(), "]}"_s));
}

class SearchPopupMenuWasm final : public SearchPopupMenu {
public:
    explicit SearchPopupMenuWasm(Ref<PopupMenuWasm>&& popup)
        : m_popup(WTF::move(popup))
    {
    }

private:
    PopupMenu* popupMenu() final { return m_popup.ptr(); }
    void saveRecentSearches(const AtomString&, const Vector<RecentSearch>&) final { }
    void loadRecentSearches(const AtomString&, Vector<RecentSearch>&) final { }
    bool enabled() final { return false; }

    Ref<PopupMenuWasm> m_popup;
};

RefPtr<PopupMenu> createPopupMenu(WebView& view, PopupMenuClient& client)
{
    return PopupMenuWasm::create(view, client);
}

RefPtr<SearchPopupMenu> createSearchPopupMenu(WebView& view, PopupMenuClient& client)
{
    return adoptRef(*new SearchPopupMenuWasm(PopupMenuWasm::create(view, client)));
}

void choosePopupItem(int viewId, int index)
{
    if (auto popup = openChoosers<PopupMenuWasm>().take(viewId))
        popup->choose(index);
}

// Color: <input type=color>
class ColorChooserWasm final : public ColorChooser, public RefCounted<ColorChooserWasm> {
    WTF_MAKE_TZONE_ALLOCATED_INLINE(ColorChooserWasm);
public:
    static Ref<ColorChooserWasm> create(WebView& view, ColorChooserClient& client, const Color& color) { return adoptRef(*new ColorChooserWasm(view, client, color)); }

    void ref() const final { RefCounted::ref(); }
    void deref() const final { RefCounted::deref(); }

    void choose(const Color& color, bool done)
    {
        Ref protectedThis { *this };
        if (!m_client)
            return;
        if (color.isValid())
            m_client->didChooseColor(color);
        if (done) {
            if (auto* client = std::exchange(m_client, nullptr))
                client->didEndChooser();
        }
    }

    void show(const Color& color)
    {
        if (!m_client)
            return;
        notifyHost(m_viewId, "color-picker", makeString('{', rectJSON(m_client->elementRectRelativeToRootView()),
            ",\"value\":\""_s, serializationForHTML(color), "\"}"_s));
    }

private:
    ColorChooserWasm(WebView& view, ColorChooserClient& client, const Color&)
        : m_viewId(view.id())
        , m_client(&client)
    {
    }

    void reattachColorChooser(const Color& color) final { show(color); }
    void setSelectedColor(const Color&) final { }
    void endChooser() final
    {
        if (!m_client)
            return;
        m_client = nullptr;
        Ref protectedThis { *this };
        forgetChooser(m_viewId, *this);
        notifyHost(m_viewId, "picker-hide");
    }

    int m_viewId;
    ColorChooserClient* m_client;
};

RefPtr<ColorChooser> createColorChooser(WebView& view, ColorChooserClient& client, const Color& color)
{
    auto chooser = ColorChooserWasm::create(view, client, color);
    openChoosers<ColorChooserWasm>().set(view.id(), chooser.ptr());
    chooser->show(color);
    return chooser;
}

static Color parseHexColor(const String& string)
{
    if (string.length() != 7 || string[0] != '#')
        return { };
    auto value = parseInteger<uint32_t>(StringView(string).substring(1), 16);
    if (!value)
        return { };
    return SRGBA<uint8_t> { static_cast<uint8_t>(*value >> 16), static_cast<uint8_t>(*value >> 8), static_cast<uint8_t>(*value), 255 };
}

void chooseColor(int viewId, const String& color, bool done)
{
    RefPtr<ColorChooserWasm> chooser;
    if (done)
        chooser = openChoosers<ColorChooserWasm>().take(viewId);
    else
        chooser = openChoosers<ColorChooserWasm>().get(viewId);
    if (chooser)
        chooser->choose(parseHexColor(color), done);
}

// Date and time: <input type=date|time|datetime-local|month|week>
class DateTimeChooserWasm final : public DateTimeChooser, public RefCounted<DateTimeChooserWasm> {
    WTF_MAKE_TZONE_ALLOCATED_INLINE(DateTimeChooserWasm);
public:
    static Ref<DateTimeChooserWasm> create(WebView& view, DateTimeChooserClient& client) { return adoptRef(*new DateTimeChooserWasm(view, client)); }

    void ref() const final { RefCounted::ref(); }
    void deref() const final { RefCounted::deref(); }

    void choose(const String& value, bool done)
    {
        Ref protectedThis { *this };
        if (!m_client)
            return;
        if (!value.isNull())
            m_client->didChooseValue(value);
        if (done) {
            if (auto* client = std::exchange(m_client, nullptr))
                client->didEndChooser();
        }
    }

private:
    DateTimeChooserWasm(WebView& view, DateTimeChooserClient& client)
        : m_viewId(view.id())
        , m_client(&client)
    {
    }

    void showChooser(const DateTimeChooserParameters& parameters) final
    {
        // min/max/step as numbers like valueAsNumber; the host converts them
        notifyHost(m_viewId, "date-time-picker", makeString('{', rectJSON(parameters.anchorRectInRootView),
            ",\"type\":\""_s, jsonEscape(parameters.type), "\",\"value\":\""_s, jsonEscape(parameters.currentValue),
            "\",\"min\":"_s, std::isfinite(parameters.minimum) ? parameters.minimum : 0, ",\"max\":"_s, std::isfinite(parameters.maximum) ? parameters.maximum : 0,
            ",\"step\":"_s, std::isfinite(parameters.step) ? parameters.step : 0, '}'));
    }

    void endChooser() final
    {
        if (!m_client)
            return;
        m_client = nullptr;
        Ref protectedThis { *this };
        forgetChooser(m_viewId, *this);
        notifyHost(m_viewId, "picker-hide");
    }

    int m_viewId;
    DateTimeChooserClient* m_client;
};

RefPtr<DateTimeChooser> createDateTimeChooser(WebView& view, DateTimeChooserClient& client)
{
    auto chooser = DateTimeChooserWasm::create(view, client);
    openChoosers<DateTimeChooserWasm>().set(view.id(), chooser.ptr());
    return chooser;
}

void chooseDateTime(int viewId, const String& value, bool done)
{
    RefPtr<DateTimeChooserWasm> chooser;
    if (done)
        chooser = openChoosers<DateTimeChooserWasm>().take(viewId);
    else
        chooser = openChoosers<DateTimeChooserWasm>().get(viewId);
    if (chooser)
        chooser->choose(value, done);
}

void closeChoosers(int viewId)
{
    choosePopupItem(viewId, -1);
    chooseColor(viewId, { }, true);
    chooseDateTime(viewId, { }, true);
}

} // namespace BrowserLite
