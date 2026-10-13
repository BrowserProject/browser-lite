// Drucken wie in Chrome: die Seite wird mit @media print in Seiten umbrochen
// und mit Skias PDF-Ausgabe zu einem PDF (A4, 1 cm Rand). Die Oberflaeche
// zeigt das PDF an und oeffnet den Druckdialog des Host-Browsers.
#pragma once

namespace WebCore {
class LocalFrame;
}

namespace BrowserLite {

// window.print() oder Strg+P (Engine-Thread)
void printFrame(int viewId, WebCore::LocalFrame&);

} // namespace BrowserLite
