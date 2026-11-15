// Damage tiles: a frame that changes only a small part of a view shows only that part.
//
// The host browser repaints a canvas whole whenever it gets a new frame, however little of it
// changed: under SwiftShader a 44 px spinner cost the GPU process about 100 ms of CPU per frame at
// 1920x1080. So the host covers the view canvas with a grid of small canvases, one per tile, created
// when the compositor first asks for them (event "tiles", the core's view-tiles.ts). A frame whose
// damage touches only a few tiles composites only those, each into its own canvas, and the
// view canvas keeps its last frame underneath. A frame that changes more shows the whole view in
// the view canvas as before and empties the tiles that showed something.
//
// Every canvas costs the host about the same per frame however small it is, so damage that comes
// back at the same place frame after frame (a pulsing ad placeholder over 12 tiles, a spinner on
// the corner of 4) gets a region: one canvas of its own, fitted to that damage. Tiles and regions
// may overlap; every canvas that shows something shows what the view is now, so their order does
// not matter: a frame redraws each one its damage touches, or empties it when the canvases drawn in
// the same frame cover all of it where the view canvas is out of date.
//
// Compositor thread only, one per view (CompositorScene).
#pragma once

#include <WebCore/IntRect.h>
#include <WebCore/IntRectHash.h>
#include <WebCore/IntSize.h>
#include <WebCore/Region.h>
#include <array>
#include <optional>
#include <wtf/HashMap.h>
#include <wtf/HashSet.h>
#include <wtf/Vector.h>
#include <wtf/text/StringBuilder.h>

namespace WebCore {
class Damage;
class FloatRect;
}

namespace BrowserLite {

class DamageTiles {
public:
    // A canvas over the view canvas. key: row << 16 | column of a tile of the grid, or
    // regionKeyBit | number of a region; the key of its canvas at the host
    struct Tile {
        WebCore::IntRect rect;
        unsigned key;
    };
    static constexpr unsigned regionKeyBit = 1u << 31;

    explicit DamageTiles(int viewId)
        : m_viewId(viewId)
    {
    }

    // The canvases a frame with this damage draws, or nullopt when it shows the whole view:
    // the damage covers too much, a canvas overlaps rectsDrawnWhole (filters that read pixels
    // around them, holes of videos) or the host has not given all of its tiles yet (they are
    // asked for here)
    std::optional<Vector<Tile>> tilesFor(const WebCore::IntSize& pixelSize, float deviceScaleFactor, const WebCore::Damage&, const Vector<WebCore::FloatRect>& rectsDrawnWhole);
    // The framebuffer of the compositor's context goes into the canvas of this tile
    bool show(const Tile&);
    // All tiles of the frame are shown: the canvases they cover that the damage touched get empty
    void didShowTiles();
    // The view canvas shows a whole frame: the canvases that showed something get empty
    void didShowWholeFrame();
    // The view stops compositing: all tiles empty and forgotten in the worker
    static void forgetView(int viewId);

private:
    struct RegionCanvas {
        unsigned key;
        WebCore::IntRect rect;
        uint64_t lastUsed;
    };
    // Where damage keeps coming: the damage near it of its last frames with damage
    struct HotSpot {
        std::array<WebCore::IntRect, 16> recent;
        // The tiles the damage of each of those frames touched
        std::array<uint8_t, 16> tiles { };
        unsigned frames { 0 };
        uint64_t lastFrame { 0 };
        WebCore::IntRect rect() const;
    };

    void updateHotSpots(const Vector<WebCore::IntRect>& clusters, const WebCore::IntRect& view, uint64_t maxArea);
    // A region for each hot spot that has none, also the regions the host drops
    void planRegions(const WebCore::IntRect& view, uint64_t maxArea, StringBuilder& regions, StringBuilder& drop);
    // The newest region the host gave a canvas for that holds rect
    RegionCanvas* readyRegionFor(const WebCore::IntRect&);
    void forgetRegions();

    int m_viewId;
    int m_tileSize { 0 };
    uint64_t m_frame { 0 };
    unsigned m_nextRegion { 0 };
    using Keys = HashSet<unsigned, IntHash<unsigned>, WTF::UnsignedWithZeroKeyHashTraits<unsigned>>;
    // Tiles asked of the host for the current tile size
    Keys m_requested;
    // Canvases showing content now, with their rects
    HashMap<unsigned, WebCore::IntRect, IntHash<unsigned>, WTF::UnsignedWithZeroKeyHashTraits<unsigned>> m_shown;
    // Covered by a canvas of this frame: emptied once it is shown
    Vector<unsigned> m_toEmpty;
    Vector<RegionCanvas> m_regions;
    // Where the view canvas no longer shows the view: damage since its last frame
    WebCore::Region m_viewStale;
    Vector<HotSpot> m_hotSpots;
};

} // namespace BrowserLite
