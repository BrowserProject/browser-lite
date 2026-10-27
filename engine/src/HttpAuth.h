// HTTP authentication (401 with Basic or Digest) for the loads of LoaderStrategy.cpp, like
// NetworkDataTaskCurl in WebKit2: curl answers the challenge itself once it has a user name and
// password, the credentials of the session live in WebCore's CredentialStorage per protection
// space (host, port, scheme, realm), and the user is asked through the host (event 'auth').
#pragma once

#include <optional>
#include <WebCore/Credential.h>
#include <wtf/Function.h>
#include <wtf/Forward.h>

namespace WebCore {
class CurlRequest;
class ProtectionSpace;
class ResourceLoader;
class ResourceRequest;
}

namespace BrowserLite::HttpAuth {

// Before a request goes out: the stored credential of its directory, sent ahead like WebKit does
// for Basic. Not for requests without credentials (allowCookies false), with credentials in the
// URL or an Authorization header of the page.
void applyStoredCredential(WebCore::CurlRequest&, const WebCore::ResourceRequest&);

// Credential stored for a protection space, empty without one; forget() after it was refused
WebCore::Credential stored(const WebCore::ProtectionSpace&);
void forget(const WebCore::ProtectionSpace&);

// The view whose user may be asked for a challenge of this load, 0 = nobody (like Chrome: the
// main frame and same origin subresources and frames, never workers or loads without credentials)
int viewToAsk(WebCore::ResourceLoader&);

// Asks the host for credentials (event 'auth'). Loads of the same view and protection space share
// one prompt. The answer is stored for the session before the waiting loads get it; nullopt =
// cancelled. Returns a ticket for withdraw().
using Answer = Function<void(std::optional<WebCore::Credential>&&)>;
uint64_t ask(int viewId, const URL&, const WebCore::ProtectionSpace&, bool retry, Answer&&);
// The load no longer waits; the last one gone closes the prompt (event 'auth-cancel')
void withdraw(uint64_t ticket);

// bl_auth_answer: user name and password, or nullopt for cancel
void answer(int requestId, std::optional<std::pair<String, String>>&&);

} // namespace BrowserLite::HttpAuth
