// Auswahlen, die der Browser selber zeigt: Liste von <select>, Farbe
// (<input type=color>) und Datum/Zeit (<input type=date> usw.). Die Engine
// schickt die Daten an die Oberflaeche, die eine eigene Auswahl zeigt und das
// Ergebnis ueber bl_popup_choose / bl_color_chosen / bl_datetime_chosen zurueckgibt.
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

// Antworten der Oberflaeche (Engine-Thread). index -1 / leerer Wert = abgebrochen
void choosePopupItem(int viewId, int index);
void chooseColor(int viewId, const String& color, bool done);
void chooseDateTime(int viewId, const String& value, bool done);

// Alles schliessen, z.B. wenn der View zugeht
void closeChoosers(int viewId);

} // namespace BrowserLite
