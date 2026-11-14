// Video overlay (#232), see VideoOverlay.h. Runs on the compositor thread; refusals go to the
// player on the engine thread.
#include "config.h"
#include "VideoOverlay.h"

#include "Engine.h"
#include "Host.h"
#include "MediaPlayerPrivateWasm.h"

#include <WebCore/CoordinatedPlatformLayerBufferHolePunch.h>
#include <WebCore/FloatRect.h>
#include <array>
#include <skia/core/SkCanvas.h>
#include <skia/core/SkM44.h>
#include <skia/core/SkMatrix.h>
#include <skia/core/SkRect.h>
#include <wtf/HashMap.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/text/MakeString.h>

namespace BrowserLite::VideoOverlay {

using namespace WebCore;

// Where the hole of a player is: the 2D transform from its layer to the device pixels of the
// view canvas (a, b, c, d, e, f like CSS matrix()) and the contents rect in the layer
struct Placement {
    std::array<float, 6> matrix;
    std::array<float, 4> rect;
    bool operator==(const Placement&) const = default;
};

using Placements = HashMap<int, Placement>;

// The holes of a frame: placements by player and the device pixels they clear in the target
struct Holes {
    Placements placements;
    Vector<FloatRect> rects;
};

struct CurrentFrame {
    int viewId;
    SkCanvas* target;
    Frame::Kind kind;
    Holes holes;
    bool punched { false };
};

static thread_local CurrentFrame* s_frame;

static HashMap<int, Holes>& shownHoles()
{
    static NeverDestroyed<HashMap<int, Holes>> holes;
    return holes;
}

static void refuse(int playerId)
{
    runOnEngineThread([playerId] {
        if (auto* player = MediaPlayerPrivateWasm::fromId(playerId))
            player->overlayRefused();
    });
}

static bool punch(uint64_t client, SkCanvas& canvas, const FloatRect& rect, bool hasEffects)
{
    int playerId = static_cast<int>(client);
    auto m = canvas.getLocalToDevice();
    bool affine = !m.rc(3, 0) && !m.rc(3, 1) && m.rc(3, 3) == 1;
    if (!s_frame || &canvas != s_frame->target || hasEffects || !affine) {
        refuse(playerId);
        return false;
    }
    // The pixels the hole clears in the target: the compositor walks every layer for each damage
    // tile, also those outside it. One more pixel around for antialiased edges.
    auto cleared = m.asM33().mapRect(SkRect::MakeXYWH(rect.x(), rect.y(), rect.width(), rect.height())).roundOut().makeOutset(1, 1);
    if (!cleared.intersect(canvas.getDeviceClipBounds()))
        cleared.setEmpty();
    if (s_frame->kind == Frame::Kind::Part) {
        s_frame->punched |= !cleared.isEmpty();
        return true;
    }
    s_frame->punched = true;
    s_frame->holes.placements.set(playerId, Placement {
        { m.rc(0, 0), m.rc(1, 0), m.rc(0, 1), m.rc(1, 1), m.rc(0, 3), m.rc(1, 3) },
        { rect.x(), rect.y(), rect.width(), rect.height() },
    });
    if (!cleared.isEmpty())
        s_frame->holes.rects.append(FloatRect(cleared.x(), cleared.y(), cleared.width(), cleared.height()));
    return true;
}

void initialize()
{
    CoordinatedPlatformLayerBufferHolePunch::setPunchCallback(punch);
}

Frame::Frame(int viewId, SkCanvas& target, Kind kind)
{
    s_frame = new CurrentFrame { viewId, &target, kind, { } };
}

bool Frame::punched() const
{
    return s_frame->punched;
}

Vector<FloatRect> holes(int viewId)
{
    auto it = shownHoles().find(viewId);
    return it == shownHoles().end() ? Vector<FloatRect> { } : it->value.rects;
}

Frame::~Frame()
{
    delete std::exchange(s_frame, nullptr);
}

static String placementJSON(int viewId, const Placement& placement)
{
    auto& [a, b, c, d, e, f] = placement.matrix;
    auto& [x, y, width, height] = placement.rect;
    return makeString("{\"view\":"_s, viewId, ",\"matrix\":["_s, a, ',', b, ',', c, ',', d, ',', e, ',', f,
        "],\"rect\":["_s, x, ',', y, ',', width, ',', height, "]}"_s);
}

void Frame::shown()
{
    auto viewId = s_frame->viewId;
    auto& shownFrame = shownHoles().add(viewId, Holes { }).iterator->value;
    auto& shown = shownFrame.placements;
    for (auto& [playerId, placement] : s_frame->holes.placements) {
        auto it = shown.find(playerId);
        if (it == shown.end() || it->value != placement)
            notifyMedia(playerId, "place"_s, placementJSON(viewId, placement));
    }
    // Holes no longer in the view (scrolled away, removed, refused)
    for (auto& playerId : shown.keys()) {
        if (!s_frame->holes.placements.contains(playerId))
            notifyMedia(playerId, "place"_s, makeString("{\"view\":"_s, viewId, '}'));
    }
    shownFrame = WTF::move(s_frame->holes);
}

void forgetView(int viewId)
{
    shownHoles().remove(viewId);
}

} // namespace BrowserLite::VideoOverlay
