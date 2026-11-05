// Hidden views wait while the user works in a visible one (HiddenViews.cpp).
#pragma once

namespace WebCore {
class Page;
}

namespace BrowserLite {

class WebView;

enum class UserInput : bool { Other, Typing };

// On the engine thread, before the input runs: the user works in a visible view, Typing for keys
// and text. Hidden views wait until no input came for a moment, after typing while the focus
// stays in a text field a little longer (WebView::updateWaitForUser).
void userWorksInVisibleView(UserInput = UserInput::Other);

// A view started to load a new page or became visible: when it is visible and loads, hidden views
// wait until the new page commits
void visibleViewMayNavigate(WebView&);

// Whether hidden views wait for the user right now
bool hiddenViewsWaitForUser();

// Holds a page like a page below a dialog (WebCore's PageGroupLoadDeferrer, for one page): its
// documents suspend their scheduled tasks (timers, event loop tasks, scripts, parser, messages)
// and its loads defer what arrives; false lets it go on where it stopped.
void setPageWaits(WebCore::Page&, bool);

} // namespace BrowserLite
