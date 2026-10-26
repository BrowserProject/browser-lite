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

struct CurrentFrame {
    int viewId;
    SkCanvas* target;
    Placements placements;
};

static thread_local CurrentFrame* s_frame;

static HashMap<int, Placements>& shownPlacements()
{
    static NeverDestroyed<HashMap<int, Placements>> placements;
    return placements;
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
    s_frame->placements.set(playerId, Placement {
        { m.rc(0, 0), m.rc(1, 0), m.rc(0, 1), m.rc(1, 1), m.rc(0, 3), m.rc(1, 3) },
        { rect.x(), rect.y(), rect.width(), rect.height() },
    });
    return true;
}

void initialize()
{
    CoordinatedPlatformLayerBufferHolePunch::setPunchCallback(punch);
}

Frame::Frame(int viewId, SkCanvas& target)
{
    s_frame = new CurrentFrame { viewId, &target, { } };
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
    auto& shown = shownPlacements().add(viewId, Placements { }).iterator->value;
    for (auto& [playerId, placement] : s_frame->placements) {
        auto it = shown.find(playerId);
        if (it == shown.end() || it->value != placement)
            notifyMedia(playerId, "place"_s, placementJSON(viewId, placement));
    }
    // Holes no longer in the view (scrolled away, removed, refused)
    for (auto& playerId : shown.keys()) {
        if (!s_frame->placements.contains(playerId))
            notifyMedia(playerId, "place"_s, makeString("{\"view\":"_s, viewId, '}'));
    }
    shown = WTF::move(s_frame->placements);
}

void forgetView(int viewId)
{
    shownPlacements().remove(viewId);
}

} // namespace BrowserLite::VideoOverlay
