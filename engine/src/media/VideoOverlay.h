// Video overlay (#232): a <video> with a host element shows the host's own <video> behind the
// view canvas instead of frames copied into the engine. Its composited layer holds a hole punch
// buffer (MediaPlayerPrivateWasm); where the compositor punches that hole (patch 0047) this file
// records the transform, and after a shown frame it tells the host where each video of the view
// goes ("place"). A hole the compositor cannot punch straight into the view (inside an offscreen
// surface of an effect, with opacity, a blend mode, a color filter or perspective) is refused:
// the player goes back to copied frames.
#pragma once

class SkCanvas;

namespace BrowserLite::VideoOverlay {

// Registers the compositor callback; before the compositor starts
void initialize();

// One composited frame of a view (compositor thread): holes punched into target while it lives
// are placements of this frame
class Frame {
public:
    // Part: a damage tile (DamageTiles.h), which places no video: a hole punched into it only
    // marks the frame as one to show whole
    enum class Kind : bool { Whole, Part };
    Frame(int viewId, SkCanvas& target, Kind = Kind::Whole);
    ~Frame();
    // The frame was shown: placements that changed since the last shown frame go to the host
    void shown();
    // A part with a hole
    bool punched() const;
};

// The last frame shown placed videos in the view (compositor thread)
bool hasPlacements(int viewId);

// The view is gone: forget its placements (compositor thread)
void forgetView(int viewId);

} // namespace BrowserLite::VideoOverlay
