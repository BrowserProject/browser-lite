// Error page like in Chrome: if a navigation in the main frame does not arrive
// (unknown name, refused, certificate, no network relay, ...), the view shows
// title, reason, code and a retry button. The page is substitute content
// (SubstituteData) under the address that failed: address bar, reload and
// back/forward work with that address. When the connection is back (online),
// the engine reloads it unless the view already loads something else. A form
// (POST) is not submitted again by itself: the request keeps its method and
// body, only the retry button sends it again. The button calls
// FrameLoader::reload for that: location.reload() always loads with GET in
// WebCore.
//
// The host may replace the template (BL_ERROR_PAGE) with placeholders
// {{lang}} {{kind}} {{title}} {{heading}} {{message}} {{code}} {{url}}
// {{retryLabel}}, all HTML-escaped. A CSP that allows no script is added in
// front, and every [data-bl-retry] element reloads through a listener the
// engine installs in the window (installRetry), so the page needs no script and
// no global.
//
// The curl codes are the reasons. What fails at the transport is turned back
// into a code by CurlRequest (patch 0039) from the socket error (Sockets.cpp).

#include "config.h"
#include "ErrorPage.h"

#include "EngineConfig.h"
#include "WebPlatformExtras.h"

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
#include <wtf/text/StringBuilder.h>

namespace BrowserLite::ErrorPage {

using namespace WebCore;

namespace {

struct Reason {
    ASCIILiteral heading;
    ASCIILiteral before; // before and after the host
    ASCIILiteral after;
    ASCIILiteral code;
    bool withDetail { false }; // curl's message too, helps when searching
};

constexpr auto notReachable = "This site can't be reached"_s;

Reason reasonFor(int curlCode)
{
    switch (curlCode) {
    case CURLE_COULDNT_RESOLVE_HOST:
        return { notReachable, "The server IP address of "_s, " could not be found."_s, "ERR_NAME_NOT_RESOLVED"_s };
    case CURLE_COULDNT_CONNECT:
        return { notReachable, ""_s, " refused to connect."_s, "ERR_CONNECTION_REFUSED"_s };
    case CURLE_INTERFACE_FAILED: // address unreachable (patch 0039)
        return { notReachable, ""_s, " is unreachable."_s, "ERR_ADDRESS_UNREACHABLE"_s };
    case CURLE_OPERATION_TIMEDOUT:
        return { notReachable, ""_s, " took too long to respond."_s, "ERR_CONNECTION_TIMED_OUT"_s };
    case CURLE_COULDNT_RESOLVE_PROXY:
        return { "No connection"_s, ""_s,
            " could not be reached through the network relay. Check your internet connection. The page reloads as soon as the connection is back."_s,
            "ERR_PROXY_CONNECTION_FAILED"_s };
    case CURLE_REMOTE_ACCESS_DENIED:
        return { notReachable, ""_s, " could not be reached through the network relay. It only connects to public addresses and web ports."_s, "ERR_ACCESS_DENIED"_s };
    case CURLE_PEER_FAILED_VERIFICATION:
        return { "Your connection is not private"_s, "The certificate of "_s,
            " is not valid (unknown issuer, different name or expired). The page was not loaded."_s, "NET::ERR_CERT_INVALID"_s };
    case CURLE_SSL_CONNECT_ERROR:
        return { "This site can't provide a secure connection"_s, ""_s, " sent an invalid response."_s, "ERR_SSL_PROTOCOL_ERROR"_s };
    case CURLE_GOT_NOTHING:
        return { "This page isn't working"_s, ""_s, " didn't send any data."_s, "ERR_EMPTY_RESPONSE"_s };
    case CURLE_SEND_ERROR:
    case CURLE_RECV_ERROR:
        return { notReachable, "The connection to "_s, " was reset."_s, "ERR_CONNECTION_RESET"_s };
    default:
        return { notReachable, ""_s, " could not be loaded."_s, "ERR_FAILED"_s, true };
    }
}

constexpr auto defaultTemplate = R"(<!doctype html>
<html lang="{{lang}}" data-kind="{{kind}}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{{title}}</title>
<style>
:root { color-scheme: light dark; --text: #202124; --muted: #5f6368; --background: #fff; --button: #1a73e8; --button-text: #fff; }
@media (prefers-color-scheme: dark) { :root { --text: #e8eaed; --muted: #9aa0a6; --background: #202124; --button: #8ab4f8; --button-text: #202124; } }
body { margin: 0; background: var(--background); color: var(--text); font: 15px/1.55 system-ui, sans-serif; }
main { box-sizing: border-box; max-width: 600px; margin: 14vh auto 0; padding: 0 24px; }
svg { width: 72px; height: 72px; color: var(--muted); }
h1 { font-size: 1.6em; font-weight: 500; line-height: 1.25; margin: 24px 0 16px; }
p { color: var(--muted); margin: 0 0 12px; overflow-wrap: anywhere; }
.code { font-size: 0.8em; }
button { margin-top: 32px; padding: 8px 20px; border: 0; border-radius: 4px; background: var(--button); color: var(--button-text); font: inherit; font-weight: 500; cursor: pointer; }
</style>
</head>
<body>
<main>
<svg viewBox="0 0 72 72" fill="none" stroke="currentColor" stroke-width="4" aria-hidden="true"><path d="M16 6h28l14 14v46H16z"/><path d="M44 6v14h14"/><circle cx="29" cy="38" r="1.5" fill="currentColor"/><circle cx="45" cy="38" r="1.5" fill="currentColor"/><path d="M28 54c5-5 13-5 18 0"/></svg>
<h1>{{heading}}</h1>
<p>{{message}}</p>
<p class="code">{{code}}</p>
<button data-bl-retry>{{retryLabel}}</button>
</main>
</body>
</html>
)"_s;

constexpr auto securityPolicy = R"(<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">)"_s;

String escapeHTML(const String& text)
{
    auto escaped = makeStringByReplacingAll(text, '&', "&amp;"_s);
    escaped = makeStringByReplacingAll(escaped, '<', "&lt;"_s);
    escaped = makeStringByReplacingAll(escaped, '>', "&gt;"_s);
    escaped = makeStringByReplacingAll(escaped, '\'', "&#39;"_s);
    return makeStringByReplacingAll(escaped, '"', "&quot;"_s);
}

using Placeholders = Vector<std::pair<ASCIILiteral, String>>;

// Unknown placeholders stay as they are
String fill(const String& pageTemplate, const Placeholders& values)
{
    StringBuilder builder;
    size_t position = 0;
    while (position < pageTemplate.length()) {
        size_t start = pageTemplate.find("{{"_s, position);
        size_t end = start == notFound ? notFound : pageTemplate.find("}}"_s, start + 2);
        if (end == notFound) {
            builder.append(StringView(pageTemplate).substring(position));
            break;
        }
        builder.append(StringView(pageTemplate).substring(position, start - position));
        auto name = StringView(pageTemplate).substring(start + 2, end - start - 2);
        auto value = std::ranges::find_if(values, [&](auto& entry) { return name == entry.first; });
        if (value != values.end())
            builder.append(escapeHTML(value->second));
        else
            builder.append(StringView(pageTemplate).substring(start, end + 2 - start));
        position = end + 2;
    }
    return builder.toString();
}

// The policy goes after a leading doctype, so the page stays in standards mode
String withSecurityPolicy(const String& page)
{
    size_t start = 0;
    while (start < page.length() && isASCIIWhitespace(page[start]))
        ++start;
    size_t insertAt = 0;
    if (StringView(page).substring(start).startsWithIgnoringASCIICase("<!doctype"_s)) {
        size_t end = page.find('>', start);
        if (end != notFound)
            insertAt = end + 1;
    }
    return makeString(StringView(page).left(insertAt), securityPolicy, StringView(page).substring(insertAt));
}

String html(const Reason& reason, const URL& url, const ResourceError& error, Kind kind, bool resubmit)
{
    auto host = url.host().isEmpty() ? url.string() : url.host().toString();
    auto code = reason.withDetail ? makeString(reason.code, " ("_s, error.localizedDescription(), ')') : String { reason.code };
    auto message = makeString(reason.before, host, reason.after);
    if (resubmit)
        message = makeString(message, " Resend submits the form data to the site again."_s);
    auto& custom = engineConfig().errorPage;
    auto page = fill(custom.isNull() ? String { defaultTemplate } : custom, {
        { "lang"_s, "en"_s },
        { "kind"_s, kind == Kind::Certificate ? "certificate"_s : "network"_s },
        { "title"_s, host },
        { "heading"_s, reason.heading },
        { "message"_s, message },
        { "code"_s, code },
        { "url"_s, url.string() },
        { "retryLabel"_s, resubmit ? "Resend"_s : "Reload"_s },
    });
    return withSecurityPolicy(page);
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

constexpr auto retrySource = R"((reload) => {
  globalThis.addEventListener('click', (event) => {
    if (event.target instanceof Element && event.target.closest('[data-bl-retry]'))
      reload();
  }, true);
})"_s;

} // namespace

void installRetry(LocalFrame& frame, JSC::JSGlobalObject& globalObject)
{
    RefPtr documentLoader = frame.loader().documentLoader();
    if (!frame.isMainFrame() || !documentLoader || documentLoader->unreachableURL().isEmpty())
        return;
    auto& vm = globalObject.vm();
    auto* reload = JSC::JSNativeStdFunction::create(vm, &globalObject, 0, "reload"_s, [frame = WeakPtr { frame }](JSC::JSGlobalObject*, JSC::CallFrame*) -> JSC::EncodedJSValue {
        // Like location.reload() only after the script
        callOnMainThread([frame] {
            if (RefPtr protectedFrame = frame.get())
                protectedFrame->loader().reload();
        });
        return JSC::JSValue::encode(JSC::jsUndefined());
    });
    JSC::MarkedArgumentBuffer arguments;
    arguments.append(reload);
    callEngineFunction(globalObject, retrySource, arguments);
}

std::optional<Kind> show(LocalFrame& frame, const ResourceError& error)
{
    // Errors from curl, not cancellation, blocking or download (those come from the LoaderStrategy)
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
    // The request that failed (still the provisional one here): reload takes it again
    ResourceRequest request { URL { url } };
    if (RefPtr failed = frame.loader().provisionalDocumentLoader()) {
        request = failed->request();
        request.setURL(URL { url });
    }
    auto kind = error.errorCode() == CURLE_PEER_FAILED_VERIFICATION ? Kind::Certificate : Kind::Network;
    auto page = html(reasonFor(error.errorCode()), url, error, kind, request.httpMethod() != "GET"_s).utf8();
    ResourceResponse response { URL { url }, "text/html"_s, static_cast<long long>(page.length()), "UTF-8"_s };
    SubstituteData data { SharedBuffer::create(page.span()), URL { url }, WTF::move(response), SubstituteData::SessionHistoryVisibility::Hidden };
    frame.loader().load(FrameLoadRequest { frame, WTF::move(request), WTF::move(data) });
    return kind;
}

} // namespace BrowserLite::ErrorPage
