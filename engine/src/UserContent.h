// Page content of the extensions of the host (packages/core/src/extensions):
// scripts and style sheets through WebCore's UserContentController, scripts
// in an isolated world per extension (DOMWrapperWorld of type User) with the
// global `extension` as the bridge to the host. Until the host sets content
// the pages keep WebCore's empty provider and nothing here runs.
#pragma once

#include <wtf/text/WTFString.h>

namespace WebCore {
class DOMWrapperWorld;
class LocalFrame;
class Page;
}

namespace BrowserLite {

class WebView;

// bl_set_user_content: replaces the content of all extensions. Scripts run
// from the next document on, styles apply to the open documents too.
void setUserContent(const String& json);

// A new page gets the content if there is any
void attachUserContent(WebCore::Page&);

// New window object in a world other than the page's: the bridge `extension`
// if it is the world of an extension
void installExtensionBridge(WebCore::LocalFrame&, WebCore::DOMWrapperWorld&, int viewId);

// bl_extension_message: the message (JSON) to extension.onMessage in every
// frame of the view where the world of the extension exists
void sendExtensionMessage(WebView&, const String& extension, const String& json);

} // namespace BrowserLite
