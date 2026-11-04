// Hidden views wait while the user works in a visible one (HiddenViews.cpp).
#pragma once

namespace WebCore {
class Page;
}

namespace BrowserLite {

// On the engine thread, before the input runs: the user works in a visible view. Hidden views
// wait until no input came for a moment (WebView::updateWaitForUser).
void userWorksInVisibleView();

// Whether hidden views wait for the user right now
bool hiddenViewsWaitForUser();

// Holds a page like a page below a dialog (WebCore's PageGroupLoadDeferrer, for one page): its
// documents suspend their scheduled tasks (timers, event loop tasks, scripts, parser, messages)
// and its loads defer what arrives; false lets it go on where it stopped.
void setPageWaits(WebCore::Page&, bool);

} // namespace BrowserLite
