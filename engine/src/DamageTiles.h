// Damage tiles: a frame that changes only a small part of a view shows only that part.
//
// The host browser repaints a canvas whole whenever it gets a new frame, however little of it
// changed: under SwiftShader a 44 px spinner cost the GPU process about 100 ms of CPU per frame at
// 1920x1080. So the host covers the view canvas with a grid of small canvases, one per tile, created
// when the compositor first asks for them (event "tiles", the core's view-tiles.ts). A frame whose
// damage touches only a few tiles composites only those, each into its own tile canvas, and the
// view canvas keeps its last frame underneath. A frame that changes more shows the whole view in
// the view canvas as before and empties the tiles that showed something.
//
// Compositor thread only, one per view (CompositorScene).
#pragma once

#include <WebCore/IntRect.h>
#include <WebCore/IntSize.h>
#include <optional>
#include <wtf/HashSet.h>
#include <wtf/Vector.h>

namespace WebCore {
class Damage;
class FloatRect;
}

namespace BrowserLite {

class DamageTiles {
public:
    // key: row << 16 | column, the key of its canvas at the host
    struct Tile {
        WebCore::IntRect rect;
        unsigned key;
    };

    explicit DamageTiles(int viewId)
        : m_viewId(viewId)
    {
    }

    // The tiles a frame with this damage draws, or nullopt when it shows the whole view:
    // the damage covers too much, a tile overlaps rectsDrawnWhole (filters that read pixels
    // around them, holes of videos) or the host has not given all of its tiles yet (they are asked for here).
    std::optional<Vector<Tile>> tilesFor(const WebCore::IntSize& pixelSize, float deviceScaleFactor, const WebCore::Damage&, const Vector<WebCore::FloatRect>& rectsDrawnWhole);
    // The framebuffer of the compositor's context goes into the canvas of this tile
    bool show(const Tile&);
    // The view canvas shows a whole frame: the tiles that showed something get empty
    void didShowWholeFrame();
    // The view stops compositing: all tiles empty and forgotten in the worker
    static void forgetView(int viewId);

private:
    int m_viewId;
    int m_tileSize { 0 };
    using Keys = HashSet<unsigned, IntHash<unsigned>, WTF::UnsignedWithZeroKeyHashTraits<unsigned>>;
    // Asked of the host for the current tile size, and showing content now
    Keys m_requested;
    Keys m_shown;
};

} // namespace BrowserLite
