// Error page for a navigation that does not arrive (see ErrorPage.cpp).
#pragma once

#include <cstdint>
#include <optional>

namespace JSC {
class JSGlobalObject;
}

namespace WebCore {
class LocalFrame;
class ResourceError;
}

namespace BrowserLite::ErrorPage {

// Certificate: the certificate of the site is not valid (address bar "Not secure")
enum class Kind : uint8_t { Network, Certificate };

// Shows it in the frame if the error comes from the network (curl), otherwise
// nullopt. Only call it when reporting the error (dispatchDidFailProvisionalLoad):
// then WebCore puts it in place of the address in the history, also for back/forward.
std::optional<Kind> show(WebCore::LocalFrame&, const WebCore::ResourceError&);

// New window object: in an error page its [data-bl-retry] elements reload
void installRetry(WebCore::LocalFrame&, JSC::JSGlobalObject&);

}
