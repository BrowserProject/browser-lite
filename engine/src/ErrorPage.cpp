// Fehlerseite wie in Chrome: kommt eine Navigation im Hauptframe nicht an (Name
// unbekannt, abgewiesen, Zertifikat, kein Relay, ...), zeigt der Tab Titel, Grund, Code
// und "Neu laden". Die Seite liegt als Ersatzinhalt (SubstituteData) unter der Adresse,
// die nicht ging: Adressleiste, Neu laden und Zurueck/Vor arbeiten mit dieser Adresse.
// Geht die Verbindung wieder (online), laedt die Engine sie neu, wenn der Tab nicht schon
// etwas anderes laedt. Ein Formular (POST) schickt sie dabei nicht von selber noch einmal ab:
// die Anfrage bleibt mit Methode und Inhalt, erst der Knopf "Erneut senden" schickt sie. Der
// Knopf ruft dafuer FrameLoader::reload (__blReload, nur in der Fehlerseite): location.reload()
// laedt in WebCore immer mit GET.
//
// Die Codes von curl sind die Gruende. Was beim Relay scheitert, macht CurlRequest
// (Patch 0039) aus dem Fehler des Sockets wieder zu einem Code (Sockets.cpp).

#include "config.h"
#include "ErrorPage.h"

#include <JavaScriptCore/JSCInlines.h>
#include <JavaScriptCore/JSNativeStdFunction.h>
#include <WebCore/DocumentLoader.h>
#include <WebCore/FrameLoadRequest.h>
#include <WebCore/FrameLoader.h>
#include <WebCore/LocalFrame.h>
#include <WebCore/NetworkStateNotifier.h>
#include <WebCore/Page.h>
#include <WebCore/ResourceError.h>
#include <WebCore/ResourceResponse.h>
#include <WebCore/SharedBuffer.h>
#include <WebCore/SubstituteData.h>
#include <curl/curl.h>
#include <wtf/MainThread.h>
#include <wtf/text/MakeString.h>

namespace BrowserLite::ErrorPage {

using namespace WebCore;

namespace {

// Texte in UTF-8
struct Reason {
    const char* title;
    const char* before; // vor und nach dem Host
    const char* after;
    ASCIILiteral code;
    bool withDetail { false }; // Meldung von curl dazu, hilft beim Suchen
};

constexpr auto notReachable = "Die Website ist nicht erreichbar";

Reason reasonFor(int curlCode)
{
    switch (curlCode) {
    case CURLE_COULDNT_RESOLVE_HOST:
        return { notReachable, "Die Server-IP-Adresse von ", " wurde nicht gefunden.", "ERR_NAME_NOT_RESOLVED"_s };
    case CURLE_COULDNT_CONNECT:
        return { notReachable, "", " hat die Verbindung abgelehnt.", "ERR_CONNECTION_REFUSED"_s };
    case CURLE_INTERFACE_FAILED: // Adresse nicht erreichbar (Patch 0039)
        return { notReachable, "", " ist nicht erreichbar.", "ERR_ADDRESS_UNREACHABLE"_s };
    case CURLE_OPERATION_TIMEDOUT:
        return { notReachable, "", " hat zu lange nicht geantwortet.", "ERR_CONNECTION_TIMED_OUT"_s };
    case CURLE_COULDNT_RESOLVE_PROXY:
        return { "Keine Verbindung zum Relay", "browser-lite erreicht sein Relay nicht und kann ",
            " darum nicht laden. Prüfen Sie die Internetverbindung. Die Seite lädt neu, sobald die Verbindung wieder steht.",
            "ERR_PROXY_CONNECTION_FAILED"_s };
    case CURLE_REMOTE_ACCESS_DENIED:
        return { notReachable, "Das Relay verbindet nicht mit ", ", es erlaubt nur öffentliche Adressen und Web-Ports.", "ERR_ACCESS_DENIED"_s };
    case CURLE_PEER_FAILED_VERIFICATION:
        return { "Ihre Verbindung ist nicht privat", "Das Zertifikat von ",
            " ist nicht gültig (unbekannter Aussteller, anderer Name oder abgelaufen). Die Seite wurde darum nicht geladen.",
            "NET::ERR_CERT_INVALID"_s };
    case CURLE_SSL_CONNECT_ERROR:
        return { "Diese Website kann keine sichere Verbindung bereitstellen", "", " hat eine ungültige Antwort gesendet.", "ERR_SSL_PROTOCOL_ERROR"_s };
    case CURLE_GOT_NOTHING:
        return { "Diese Seite funktioniert nicht", "", " hat keine Daten gesendet.", "ERR_EMPTY_RESPONSE"_s };
    case CURLE_SEND_ERROR:
    case CURLE_RECV_ERROR:
        return { notReachable, "Die Verbindung zu ", " wurde zurückgesetzt.", "ERR_CONNECTION_RESET"_s };
    default:
        return { notReachable, "", " konnte nicht geladen werden.", "ERR_FAILED"_s, true };
    }
}

String escapeHTML(const String& text)
{
    auto escaped = makeStringByReplacingAll(text, '&', "&amp;"_s);
    escaped = makeStringByReplacingAll(escaped, '<', "&lt;"_s);
    escaped = makeStringByReplacingAll(escaped, '>', "&gt;"_s);
    return makeStringByReplacingAll(escaped, '"', "&quot;"_s);
}

constexpr auto style = R"(<style>
:root { color-scheme: light dark; --text: #202124; --muted: #5f6368; --background: #fff; --button: #1a73e8; --button-text: #fff; }
@media (prefers-color-scheme: dark) { :root { --text: #e8eaed; --muted: #9aa0a6; --background: #202124; --button: #8ab4f8; --button-text: #202124; } }
body { margin: 0; background: var(--background); color: var(--text); font: 15px/1.55 system-ui, sans-serif; }
main { box-sizing: border-box; max-width: 600px; margin: 14vh auto 0; padding: 0 24px; }
svg { width: 72px; height: 72px; color: var(--muted); }
h1 { font-size: 1.6em; font-weight: 500; line-height: 1.25; margin: 24px 0 16px; }
p { color: var(--muted); margin: 0 0 12px; overflow-wrap: anywhere; }
.code { font-size: 0.8em; }
button { margin-top: 32px; padding: 8px 20px; border: 0; border-radius: 4px; background: var(--button); color: var(--button-text); font: inherit; font-weight: 500; cursor: pointer; }
</style>)"_s;

constexpr auto icon = R"(<svg viewBox="0 0 72 72" fill="none" stroke="currentColor" stroke-width="4" aria-hidden="true"><path d="M16 6h28l14 14v46H16z"/><path d="M44 6v14h14"/><circle cx="29" cy="38" r="1.5" fill="currentColor"/><circle cx="45" cy="38" r="1.5" fill="currentColor"/><path d="M28 54c5-5 13-5 18 0"/></svg>)"_s;

String html(const Reason& reason, const URL& url, const ResourceError& error, bool resubmit)
{
    auto host = escapeHTML(url.host().isEmpty() ? url.string() : url.host().toString());
    auto code = reason.withDetail ? makeString(reason.code, " ("_s, escapeHTML(error.localizedDescription()), ')') : String { reason.code };
    return makeString("<!doctype html><html lang=\"de\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>"_s,
        host, "</title>"_s, style, "</head><body><main>"_s, icon,
        "<h1>"_s, String::fromUTF8(reason.title), "</h1><p>"_s, String::fromUTF8(reason.before), "<b>"_s, host, "</b>"_s, String::fromUTF8(reason.after),
        "</p>"_s, resubmit ? String::fromUTF8("<p>Mit „Erneut senden“ gehen die Formulardaten noch einmal an die Website.</p>") : String { },
        "<p class=\"code\">"_s, code,
        "</p><button id=\"reload\">"_s, resubmit ? "Erneut senden"_s : "Neu laden"_s, "</button></main><script>document.getElementById('reload').onclick = () => __blReload();</script></body></html>"_s);
}

void reloadAfterReconnect(bool onLine)
{
    if (!onLine)
        return;
    Page::forEachPage([](Page& page) {
        RefPtr frame = page.localMainFrame();
        if (!frame)
            return;
        auto& loader = frame->loader();
        RefPtr documentLoader = loader.documentLoader();
        if (documentLoader && !documentLoader->unreachableURL().isEmpty() && !loader.provisionalDocumentLoader()
            && documentLoader->request().httpMethod() == "GET"_s)
            loader.reload();
    });
}

} // namespace

void installBridge(LocalFrame& frame, JSC::JSGlobalObject& globalObject)
{
    RefPtr documentLoader = frame.loader().documentLoader();
    if (!frame.isMainFrame() || !documentLoader || documentLoader->unreachableURL().isEmpty())
        return;
    auto& vm = globalObject.vm();
    auto* function = JSC::JSNativeStdFunction::create(vm, &globalObject, 0, "__blReload"_s, [frame = WeakPtr { frame }](JSC::JSGlobalObject*, JSC::CallFrame*) -> JSC::EncodedJSValue {
        // Wie location.reload() erst nach dem Skript
        callOnMainThread([frame] {
            if (RefPtr protectedFrame = frame.get())
                protectedFrame->loader().reload();
        });
        return JSC::JSValue::encode(JSC::jsUndefined());
    });
    globalObject.putDirect(vm, JSC::Identifier::fromString(vm, "__blReload"_s), function, static_cast<unsigned>(JSC::PropertyAttribute::DontEnum));
}

std::optional<Kind> show(LocalFrame& frame, const ResourceError& error)
{
    // Fehler von curl, nicht Abbruch, Sperre oder Download (die kommen aus der LoaderStrategy)
    if (error.domain() != "CurlErrorDomain"_s || error.isCancellation())
        return std::nullopt;
    URL url = frame.loader().provisionalLoadErrorBeingHandledURL();
    if (url.isEmpty())
        url = error.failingURL();
    if (!url.protocolIsInHTTPFamily())
        return std::nullopt;
    static bool listening = false;
    if (!std::exchange(listening, true))
        NetworkStateNotifier::singleton().addListener(reloadAfterReconnect);
    // Die Anfrage, die scheiterte (hier noch die vorlaeufige): Neu laden nimmt sie wieder
    ResourceRequest request { URL { url } };
    if (RefPtr failed = frame.loader().provisionalDocumentLoader()) {
        request = failed->request();
        request.setURL(URL { url });
    }
    auto page = html(reasonFor(error.errorCode()), url, error, request.httpMethod() != "GET"_s).utf8();
    ResourceResponse response { URL { url }, "text/html"_s, static_cast<long long>(page.length()), "UTF-8"_s };
    SubstituteData data { SharedBuffer::create(page.span()), URL { url }, WTF::move(response), SubstituteData::SessionHistoryVisibility::Hidden };
    frame.loader().load(FrameLoadRequest { frame, WTF::move(request), WTF::move(data) });
    return error.errorCode() == CURLE_PEER_FAILED_VERIFICATION ? Kind::Certificate : Kind::Network;
}

} // namespace BrowserLite::ErrorPage
