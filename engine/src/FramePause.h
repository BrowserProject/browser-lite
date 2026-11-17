// The script of a cross-site frame pauses while the user needs the engine thread (FramePause.cpp).
#pragma once

#include <span>
#include <wtf/Function.h>

namespace WebCore {
class DoublePoint;
}

namespace BrowserLite {

class WebView;

// At a safepoint of the running script while urgent work waits (EngineLoop.cpp): a long script
// (scriptRunsLong) of a site that only has frames (no top-level document in any view) pauses
// until the user no longer needs the engine thread, input waits for it or its document goes away.
// Returns whether it paused.
bool pauseFrameScriptForUser();

// On the engine thread before input for the view runs. points: where a pointer input lands in
// the view, none for keys and text. Whether the input must wait for a paused frame's script to
// end: it reaches one of the paused frames (they have the focus, it lands in one or the pointer
// leaves one), or earlier input of the view waits. holdInputForPausedFrame then takes it.
bool inputWaitsForPausedFrame(WebView&, std::span<const WebCore::DoublePoint> points);

// Runs input after the paused frame's script ended, in order; dropped instead when the view
// is closed or a dialog blocks it by then
void holdInputForPausedFrame(WebView&, Function<void(WebView&)>&& input, Function<void()>&& dropped);

} // namespace BrowserLite
