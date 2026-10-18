// Choosers the browser shows itself: the list of a <select>, color
// (<input type=color>) and date/time (<input type=date> etc.). The engine
// sends the data to the host, which shows its own chooser and returns the
// result through bl_popup_choose / bl_color_chosen / bl_datetime_chosen.
#pragma once

#include <WebCore/ColorChooser.h>
#include <WebCore/DateTimeChooser.h>
#include <WebCore/PopupMenu.h>
#include <WebCore/SearchPopupMenu.h>
#include <wtf/Forward.h>

namespace WebCore {
class Color;
class ColorChooserClient;
class DateTimeChooserClient;
class PopupMenuClient;
}

namespace BrowserLite {

class WebView;

RefPtr<WebCore::PopupMenu> createPopupMenu(WebView&, WebCore::PopupMenuClient&);
RefPtr<WebCore::SearchPopupMenu> createSearchPopupMenu(WebView&, WebCore::PopupMenuClient&);
RefPtr<WebCore::ColorChooser> createColorChooser(WebView&, WebCore::ColorChooserClient&, const WebCore::Color&);
RefPtr<WebCore::DateTimeChooser> createDateTimeChooser(WebView&, WebCore::DateTimeChooserClient&);

// Answers of the host (engine thread). index -1 / empty value = cancelled
void choosePopupItem(int viewId, int index);
void chooseColor(int viewId, const String& color, bool done);
void chooseDateTime(int viewId, const String& value, bool done);

// Closes everything, e.g. when the view closes
void closeChoosers(int viewId);

} // namespace BrowserLite
