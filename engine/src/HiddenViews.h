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
// loaded (its load event)
void visibleViewMayNavigate(WebView&);

// A view became visible (a switch of tabs, the host page shown again): the user waits for it like
// for input, and hidden views also wait until it made its first frame since (the frame that was
// due, WebView::waitsForFrameSinceShown) and until a page it loads loaded
void visibleViewShown(WebView&);

// Whether hidden views wait for the user right now
bool hiddenViewsWaitForUser();

// Whether input to a visible view (or a view shown) came within the last moment, without the
// longer holds of typing and navigation
bool userJustWorked();

// Whether the user waits for the engine thread: urgent work waits (input, a call of the host, the
// compositor's answer) or hidden views wait for the user
bool userNeedsEngineThread();

// At a safepoint of the running script while urgent work waits (EngineLoop.cpp): a script of a
// hidden view that waits for the user pauses until the user no longer needs the engine thread
// (WebView::pauseScriptForUser), unless another view shares script with its page. Returns whether
// it paused.
bool pauseHiddenScriptForUser();

// Holds a page like a page below a dialog (WebCore's PageGroupLoadDeferrer, for one page): its
// documents suspend their scheduled tasks (timers, event loop tasks, scripts, parser, messages),
// its loads defer what arrives and its style recalculation and layout wait (patch 0125, also
// the hit test for the element under the mouse after a layout, patch 0131; load events and the
// parser respect the suspension through patches 0126 and 0127); false lets it go on where it
// stopped.
void setPageWaits(WebCore::Page&, bool);

} // namespace BrowserLite
