#include "config.h"
#include "HttpAuth.h"

#include "Host.h"
#include "Strategies.h"
#include "WebView.h"

#include <WebCore/Credential.h>
#include <WebCore/CredentialStorage.h>
#include <WebCore/CurlRequest.h>
#include <WebCore/DocumentInlines.h>
#include <WebCore/DocumentPage.h>
#include <WebCore/LocalFrame.h>
#include <WebCore/LocalFrameInlines.h>
#include <WebCore/NetworkStorageSession.h>
#include <WebCore/OriginAccessPatterns.h>
#include <WebCore/Page.h>
#include <WebCore/ProtectionSpace.h>
#include <WebCore/ResourceLoader.h>
#include <WebCore/SecurityOrigin.h>
#include <wtf/HashMap.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/text/MakeString.h>

namespace BrowserLite::HttpAuth {

using namespace WebCore;

// One partition for the whole engine: Chrome does not split its HTTP auth cache by site either
static const String& partition()
{
    static NeverDestroyed<String> name { emptyString() };
    return name;
}

static CredentialStorage& storage()
{
    return networkStorageSession().credentialStorage();
}

static bool mayUseCredentials(const ResourceRequest& request)
{
    return request.allowCookies() && !request.url().hasCredentials() && !request.hasHTTPHeaderField(HTTPHeaderName::Authorization);
}

void applyStoredCredential(CurlRequest& curlRequest, const ResourceRequest& request)
{
    if (!request.url().protocolIsInHTTPFamily() || !mayUseCredentials(request))
        return;
    auto credential = storage().get(partition(), request.url());
    if (credential.isEmpty())
        return;
    curlRequest.setAuthenticationScheme(ProtectionSpace::AuthenticationScheme::HTTPBasic);
    curlRequest.setUserPass(credential.user(), credential.password());
}

Credential stored(const ProtectionSpace& space)
{
    return storage().get(partition(), space);
}

void forget(const ProtectionSpace& space)
{
    storage().remove(partition(), space);
}

int viewToAsk(ResourceLoader& loader)
{
    auto& options = loader.options();
    if (options.storedCredentialsPolicy != StoredCredentialsPolicy::Use || options.initiatorContext == InitiatorContext::Worker)
        return 0;
    switch (options.destination) {
    case FetchOptions::Destination::Worker:
    case FetchOptions::Destination::Sharedworker:
    case FetchOptions::Destination::Serviceworker:
        return 0;
    default:
        break;
    }
    if (!mayUseCredentials(loader.request()) || !loader.isAllowedToAskUserForCredentials())
        return 0;
    RefPtr frame = loader.frame();
    RefPtr document = frame ? frame->document() : nullptr;
    if (!document)
        return 0;
    // WebCore lets every frame navigation ask; Chrome only the main frame and the same origin
    if (!frame->isMainFrame() && !document->topOrigin().canRequest(loader.request().url(), OriginAccessPatternsForWebProcess::singleton()))
        return 0;
    // Pages of service and shared workers belong to no view
    int viewId = 0;
    WebView::forEach([&](WebView& view) {
        if (&view.page() == frame->page())
            viewId = view.id();
    });
    return viewId;
}

namespace {

struct Prompt {
    int viewId { 0 };
    URL url;
    ProtectionSpace space;
    Vector<std::pair<uint64_t, Answer>> waiting;
};

}

static HashMap<int, Prompt>& prompts()
{
    static NeverDestroyed<HashMap<int, Prompt>> map;
    return map;
}

static ASCIILiteral schemeName(ProtectionSpace::AuthenticationScheme scheme)
{
    return scheme == ProtectionSpace::AuthenticationScheme::HTTPDigest ? "digest"_s : "basic"_s;
}

uint64_t ask(int viewId, const URL& url, const ProtectionSpace& space, bool retry, Answer&& answer)
{
    static uint64_t nextTicket = 1;
    uint64_t ticket = nextTicket++;
    for (auto& prompt : prompts().values()) {
        if (prompt.viewId == viewId && prompt.space == space) {
            prompt.waiting.append({ ticket, WTF::move(answer) });
            return ticket;
        }
    }
    static int nextRequestID = 1;
    int id = nextRequestID++;
    URL shown = url;
    shown.removeCredentials();
    prompts().set(id, Prompt { viewId, shown, space, { } }).iterator->value.waiting.append({ ticket, WTF::move(answer) });
    notifyHost(viewId, "auth", makeString("{\"id\":"_s, id, ",\"url\":\""_s, jsonEscape(shown.string()),
        "\",\"origin\":\""_s, jsonEscape(SecurityOrigin::create(shown)->toString()),
        "\",\"realm\":\""_s, jsonEscape(space.realm()), "\",\"scheme\":\""_s, schemeName(space.authenticationScheme()),
        "\",\"retry\":"_s, retry ? "true"_s : "false"_s, '}'));
    return ticket;
}

void withdraw(uint64_t ticket)
{
    for (auto& [id, prompt] : prompts()) {
        auto index = prompt.waiting.findIf([&](auto& entry) { return entry.first == ticket; });
        if (index == notFound)
            continue;
        prompt.waiting.removeAt(index);
        if (prompt.waiting.isEmpty()) {
            int viewId = prompt.viewId;
            int requestId = id;
            prompts().remove(requestId);
            notifyHost(viewId, "auth-cancel", makeString("{\"id\":"_s, requestId, '}'));
        }
        return;
    }
}

void answer(int requestId, std::optional<std::pair<String, String>>&& userAndPassword)
{
    auto found = prompts().find(requestId);
    if (found == prompts().end())
        return;
    auto prompt = WTF::move(found->value);
    prompts().remove(found);
    std::optional<Credential> credential;
    if (userAndPassword) {
        credential = Credential(userAndPassword->first, userAndPassword->second, CredentialPersistence::ForSession);
        storage().set(partition(), *credential, prompt.space, prompt.url);
    }
    for (auto& entry : prompt.waiting)
        entry.second(std::optional<Credential> { credential });
}

} // namespace BrowserLite::HttpAuth
