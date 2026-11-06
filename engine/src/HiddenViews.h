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

// A view started to load a new page: when it is visible, hidden views wait until the new page
// commits
void visibleViewMayNavigate(WebView&);

// A view became visible (a switch of tabs, the host page shown again): the user waits for it like
// for input, and hidden views also wait until it made its first frame since (the frame that was
// due, WebView::waitsForFrameSinceShown) and until a page it loads commits
void visibleViewShown(WebView&);

// Whether hidden views wait for the user right now
bool hiddenViewsWaitForUser();

// Holds a page like a page below a dialog (WebCore's PageGroupLoadDeferrer, for one page): its
// documents suspend their scheduled tasks (timers, event loop tasks, scripts, parser, messages)
// and its loads defer what arrives; false lets it go on where it stopped.
void setPageWaits(WebCore::Page&, bool);

} // namespace BrowserLite
