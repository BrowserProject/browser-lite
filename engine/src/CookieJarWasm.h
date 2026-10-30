#pragma once

#include <wtf/Ref.h>

namespace WebCore {
class CookieJar;
}

namespace BrowserLite {

// Cookie jar of pages and service workers on the shared session (networkStorageSession), with
// the Cookie Store API (cookieStore.get, getAll, set, delete), which curl's session leaves out.
Ref<WebCore::CookieJar> createCookieJar();

} // namespace BrowserLite
