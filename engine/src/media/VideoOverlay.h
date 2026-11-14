// Video overlay (#232): a <video> with a host element shows the host's own <video> behind the
// view canvas instead of frames copied into the engine. Its composited layer holds a hole punch
// buffer (MediaPlayerPrivateWasm); where the compositor punches that hole (patch 0047) this file
// records the transform, and after a shown frame it tells the host where each video of the view
// goes ("place"). A hole the compositor cannot punch straight into the view (inside an offscreen
// surface of an effect, with opacity, a blend mode, a color filter or perspective) is refused:
// the player goes back to copied frames.
#pragma once

#include <wtf/Vector.h>

class SkCanvas;

namespace WebCore {
class FloatRect;
}

namespace BrowserLite::VideoOverlay {

// Registers the compositor callback; before the compositor starts
void initialize();

// One composited frame of a view (compositor thread): holes punched into target while it lives
// are placements of this frame
class Frame {
public:
    // Part: a damage tile (DamageTiles.h), which places no video: a hole punched into it where
    // the tile shows it marks the frame as one to show whole. Holes outside the tile do not count.
    enum class Kind : bool { Whole, Part };
    Frame(int viewId, SkCanvas& target, Kind = Kind::Whole);
    ~Frame();
    // The frame was shown: placements that changed since the last shown frame go to the host
    void shown();
    // A part with a hole in it
    bool punched() const;
};

// Where the last whole frame shown punched holes, in device pixels of the view and clipped to it
// (compositor thread). A damage tile there shows a whole frame instead: through a hole of its own
// it would show that frame's content over the video, and without one the host would keep the
// video where it no longer is (placements change only with whole frames).
Vector<WebCore::FloatRect> holes(int viewId);

// The view is gone: forget its placements (compositor thread)
void forgetView(int viewId);

} // namespace BrowserLite::VideoOverlay
