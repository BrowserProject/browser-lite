// The Cookie Store API on curl's cookie database. WebKit's CookieJar rejects it unless the port
// implements it (WebKit2 does through the network process, curl's NetworkStorageSession has only
// FIXMEs), so cookieStore existed but every call failed with a bare TypeError (Airbnb's consent
// code, found in a sweep). Reading takes the cookies document.cookie would see; writing goes
// through the same check as document.cookie (no HttpOnly cookies, domain must match).

#include "config.h"
#include "CookieJarWasm.h"

#include "Strategies.h"

#include <WebCore/Cookie.h>
#include <WebCore/CookieJar.h>
#include <WebCore/CookieJarDB.h>
#include <WebCore/CookieStoreGetOptions.h>
#include <WebCore/Document.h>
#include <WebCore/NetworkStorageSession.h>
#include <WebCore/StorageSessionProvider.h>
#include <cmath>
#include <wtf/WallTime.h>
#include <wtf/text/MakeString.h>
#include <wtf/text/StringBuilder.h>

namespace BrowserLite {

using namespace WebCore;

namespace {

class SessionProvider final : public StorageSessionProvider {
public:
    static Ref<SessionProvider> create() { return adoptRef(*new SessionProvider); }
    NetworkStorageSession* storageSession() const final { return &networkStorageSession(); }
};

class CookieJarWasm final : public CookieJar {
public:
    static Ref<CookieJarWasm> create() { return adoptRef(*new CookieJarWasm); }

    void getCookiesAsync(Document& document, const URL& url, const CookieStoreGetOptions& options, CompletionHandler<void(std::optional<Vector<Cookie>>&&)>&& completionHandler) const final
    {
        Vector<Cookie> all;
        Vector<Cookie> visible;
        if (getRawCookies(document, url, all)) {
            bool secure = shouldIncludeSecureCookies(url) == IncludeSecureCookies::Yes;
            for (auto& cookie : all) {
                if (!cookie.httpOnly && (secure || !cookie.secure) && (options.name.isNull() || cookie.name == options.name))
                    visible.append(WTF::move(cookie));
            }
        }
        completionHandler(WTF::move(visible));
    }

    void setCookieAsync(Document& document, const URL& url, const Cookie& cookie, CompletionHandler<void(bool)>&& completionHandler) const final
    {
        // As a Set-Cookie line. A domain with a leading dot is one for subdomains too, without it
        // the cookie is host-only. Secure only where secure cookies can be read again (the Cookie
        // Store API marks every cookie secure, it also runs on http://localhost)
        StringBuilder line;
        line.append(cookie.name, '=', cookie.value);
        if (cookie.domain.startsWith('.'))
            line.append("; Domain="_s, cookie.domain);
        if (!cookie.path.isEmpty())
            line.append("; Path="_s, cookie.path);
        if (cookie.expires) {
            auto now = WallTime::now().secondsSinceEpoch().milliseconds();
            line.append("; Max-Age="_s, static_cast<int64_t>(std::floor((*cookie.expires - now) / 1000)));
        }
        if (cookie.secure && shouldIncludeSecureCookies(url) == IncludeSecureCookies::Yes)
            line.append("; Secure"_s);
        completionHandler(networkStorageSession().cookieDatabase().setCookie(document.firstPartyForCookies(), url, line.toString(), CookieJarDB::Source::Script));
    }

private:
    CookieJarWasm()
        : CookieJar(SessionProvider::create())
    {
    }
};

} // namespace

Ref<CookieJar> createCookieJar()
{
    return CookieJarWasm::create();
}

} // namespace BrowserLite
