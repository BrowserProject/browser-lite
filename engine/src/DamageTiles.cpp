#include "config.h"
#include "DamageTiles.h"

#include "GpuRaster.h"
#include "Host.h"
#include <WebCore/Damage.h>
#include <WebCore/FloatRect.h>
#include <WebCore/Region.h>
#include <cmath>
#include <emscripten/emscripten.h>
#include <wtf/Scope.h>
#include <wtf/text/MakeString.h>
#include <wtf/text/StringBuilder.h>

// In the worker of the compositor (engine-pre.js): Module.blCanvases.get(viewId).tiles holds the
// canvases of the tiles and regions of the current size by key (unsigned: region keys have the
// top bit)
EM_JS(int, bl_tile_ready, (int viewId, int size, unsigned key), {
    key = key >>> 0;
    var target = Module.blCanvases && Module.blCanvases.get(viewId);
    return target && target.tiles && target.tiles.size == size && target.tiles.canvases.has(key) ? 1 : 0;
});

// A new tile size: the canvases of the old one are no longer used (the host replaces them)
EM_JS(void, bl_tiles_resize, (int viewId, int size), {
    var target = Module.blCanvases && Module.blCanvases.get(viewId);
    if (target)
        target.tiles = { size: size, canvases: new Map() };
});

// An empty tile shows the view canvas underneath
EM_JS(void, bl_tile_clear, (int viewId, unsigned key), {
    key = key >>> 0;
    var target = Module.blCanvases && Module.blCanvases.get(viewId);
    var tile = target && target.tiles && target.tiles.canvases.get(key);
    if (tile && tile.bitmapContext)
        Module.blEmptyBitmap(tile.bitmapContext);
});

// A region the compositor no longer uses (its canvas is empty): the host removes it
EM_JS(void, bl_tile_forget, (int viewId, unsigned key), {
    key = key >>> 0;
    var target = Module.blCanvases && Module.blCanvases.get(viewId);
    if (target && target.tiles)
        target.tiles.canvases.delete(key);
});

EM_JS(void, bl_tiles_forget, (int viewId), {
    var target = Module.blCanvases && Module.blCanvases.get(viewId);
    if (!target || !target.tiles)
        return;
    target.tiles.canvases.forEach(function (tile) {
        if (tile.bitmapContext)
            Module.blEmptyBitmap(tile.bitmapContext);
    });
    target.tiles = null;
});

namespace BrowserLite {

using namespace WebCore;

// Tiles of 128 CSS pixels: a spinner touches one to four, a 1920x1080 view has 135
static constexpr float tileSizeInCSSPixels = 128;
// A frame shows tiles while they are at most this many canvases and cover at most half of the
// view: beyond that a whole frame costs the host about as much as the small ones (measured under
// SwiftShader at 1920x1080, GPU process CPU per frame: one tile 7.5 ms, four 18 ms, the whole view
// 100 ms). On a phone (393x601 CSS pixels at ratio 2) a spinner on the corner of four tiles covers
// 28 %.
static constexpr unsigned maxTiles = 16;
static constexpr unsigned maxTileShare = 2;
// Regions: damage that came in this many frames at the same place (within a quarter tile of the
// damage before) and touched two tiles or more a frame gets a canvas of its own, fitted to the
// damage of its last 16 frames, at most this many per view. A place without damage for a while is
// forgotten.
static constexpr unsigned regionAfterFrames = 12;
static constexpr unsigned maxRegions = 8;
static constexpr unsigned maxHotSpots = 16;
static constexpr uint64_t hotSpotFrames = 120;
// Region canvases start and end on this many frame pixels
static constexpr int regionGrid = 16;
// Damage rects beyond this many are not followed for regions
static constexpr size_t maxClusteredRects = 64;

static unsigned keyOf(int column, int row)
{
    return static_cast<unsigned>(row) << 16 | static_cast<unsigned>(column);
}

static uint64_t areaOf(const IntRect& rect)
{
    return static_cast<uint64_t>(rect.width()) * rect.height();
}

static int floorTo(int value, int grid)
{
    return value >= 0 ? value / grid * grid : -((-value + grid - 1) / grid * grid);
}

// The tiles of the grid a rect touches
template<typename Function>
static void forEachTile(const IntRect& rect, const IntRect& view, int tileSize, const Function& function)
{
    for (int row = rect.y() / tileSize; row <= (rect.maxY() - 1) / tileSize; ++row) {
        for (int column = rect.x() / tileSize; column <= (rect.maxX() - 1) / tileSize; ++column)
            function(DamageTiles::Tile { intersection(IntRect { column * tileSize, row * tileSize, tileSize, tileSize }, view), keyOf(column, row) });
    }
}

// Damage rects within gap of each other as one bounding box each
static Vector<IntRect> clustersOf(const Vector<IntRect>& rects, int gap)
{
    Vector<IntRect> clusters;
    for (auto& rect : rects) {
        auto cluster = rect;
        for (bool merged = true; merged;) {
            merged = false;
            for (size_t i = 0; i < clusters.size(); ++i) {
                auto near = clusters[i];
                near.inflate(gap);
                if (!near.intersects(cluster))
                    continue;
                cluster.unite(clusters[i]);
                clusters.removeAt(i);
                merged = true;
                break;
            }
        }
        clusters.append(cluster);
    }
    return clusters;
}

IntRect DamageTiles::HotSpot::rect() const
{
    IntRect united;
    for (unsigned i = 0; i < std::min<unsigned>(frames, recent.size()); ++i)
        united.unite(recent[i]);
    return united;
}

void DamageTiles::updateHotSpots(const Vector<IntRect>& clusters, const IntRect& view, uint64_t maxArea)
{
    for (auto& cluster : clusters) {
        if (areaOf(cluster) > maxArea)
            continue;
        auto near = cluster;
        near.inflate(m_tileSize / 4);
        auto index = m_hotSpots.findIf([&](auto& spot) { return spot.rect().intersects(near); });
        auto tilesOf = [&](const IntRect& rect) {
            unsigned tiles = 0;
            forEachTile(rect, view, m_tileSize, [&](const auto&) { ++tiles; });
            return static_cast<uint8_t>(std::min(tiles, 255u));
        };
        if (index == notFound) {
            HotSpot spot;
            spot.recent[0] = cluster;
            spot.tiles[0] = tilesOf(cluster);
            spot.frames = 1;
            spot.lastFrame = m_frame;
            m_hotSpots.append(spot);
            continue;
        }
        auto& spot = m_hotSpots[index];
        // A second cluster of the same frame joins the damage of that frame
        if (spot.lastFrame == m_frame) {
            auto last = (spot.frames - 1) % spot.recent.size();
            spot.recent[last].unite(cluster);
            spot.tiles[last] = tilesOf(spot.recent[last]);
            continue;
        }
        spot.recent[spot.frames % spot.recent.size()] = cluster;
        spot.tiles[spot.frames % spot.recent.size()] = tilesOf(cluster);
        ++spot.frames;
        spot.lastFrame = m_frame;
    }
    m_hotSpots.removeAllMatching([&](auto& spot) {
        return m_frame - spot.lastFrame > hotSpotFrames || !view.contains(spot.rect());
    });
    while (m_hotSpots.size() > maxHotSpots) {
        auto oldest = std::min_element(m_hotSpots.begin(), m_hotSpots.end(), [](auto& a, auto& b) { return a.lastFrame < b.lastFrame; });
        m_hotSpots.removeAt(oldest - m_hotSpots.begin());
    }
}

void DamageTiles::planRegions(const IntRect& view, uint64_t maxArea, StringBuilder& regions, StringBuilder& drop)
{
    auto dropRegion = [&](size_t index) {
        auto key = m_regions[index].key;
        bl_tile_forget(m_viewId, key);
        drop.append(drop.isEmpty() ? ""_s : ","_s, key);
        m_regions.removeAt(index);
    };
    // Regions out of the view or unused for a while, unless they show something
    for (size_t i = m_regions.size(); i--;) {
        auto& region = m_regions[i];
        if (!m_shown.contains(region.key) && (m_frame - region.lastUsed > hotSpotFrames || !view.contains(region.rect)))
            dropRegion(i);
    }
    for (auto& spot : m_hotSpots) {
        if (spot.frames < regionAfterFrames)
            continue;
        // The damage of its recent frames, on the grid of regions
        auto damaged = spot.rect();
        auto rect = damaged;
        rect.inflate(2);
        int x = floorTo(rect.x(), regionGrid);
        int y = floorTo(rect.y(), regionGrid);
        rect = intersection(IntRect { x, y, floorTo(rect.maxX() + regionGrid - 1, regionGrid) - x, floorTo(rect.maxY() + regionGrid - 1, regionGrid) - y }, view);
        if (rect.isEmpty() || areaOf(rect) > maxArea)
            continue;
        // A region that holds it and is not much larger
        if (std::any_of(m_regions.begin(), m_regions.end(), [&](auto& region) { return region.rect.contains(damaged) && areaOf(region.rect) <= 2 * areaOf(rect); }))
            continue;
        // Only instead of two tiles or more a frame, and not larger than they are
        unsigned recentFrames = std::min<unsigned>(spot.frames, spot.recent.size());
        unsigned tiles = 0;
        for (unsigned i = 0; i < recentFrames; ++i)
            tiles += spot.tiles[i];
        if (tiles < 2 * recentFrames || recentFrames * areaOf(rect) > tiles * areaOf({ 0, 0, m_tileSize, m_tileSize }))
            continue;
        if (m_regions.size() >= maxRegions) {
            size_t unused = notFound;
            for (size_t i = 0; i < m_regions.size(); ++i) {
                if (!m_shown.contains(m_regions[i].key) && (unused == notFound || m_regions[i].lastUsed < m_regions[unused].lastUsed))
                    unused = i;
            }
            if (unused == notFound)
                return;
            dropRegion(unused);
        }
        m_nextRegion = m_nextRegion % 0xffffff + 1;
        RegionCanvas region { regionKeyBit | m_nextRegion, rect, m_frame };
        m_regions.append(region);
        regions.append(regions.isEmpty() ? ""_s : ","_s, '[', region.key, ',', rect.x(), ',', rect.y(), ',', rect.width(), ',', rect.height(), ']');
    }
}

DamageTiles::RegionCanvas* DamageTiles::readyRegionFor(const IntRect& rect)
{
    RegionCanvas* smallest = nullptr;
    for (auto& region : m_regions) {
        if (region.rect.contains(rect) && (!smallest || areaOf(region.rect) < areaOf(smallest->rect)) && bl_tile_ready(m_viewId, m_tileSize, region.key))
            smallest = &region;
    }
    return smallest;
}

void DamageTiles::forgetRegions()
{
    m_regions.clear();
    m_hotSpots.clear();
}

std::optional<Vector<DamageTiles::Tile>> DamageTiles::tilesFor(const IntSize& pixelSize, float deviceScaleFactor, const Damage& damage, const Vector<FloatRect>& rectsDrawnWhole)
{
    int tileSize = std::max(64, static_cast<int>(std::lround(tileSizeInCSSPixels * deviceScaleFactor)));
    if (tileSize != m_tileSize) {
        didShowWholeFrame();
        m_tileSize = tileSize;
        m_requested.clear();
        // The host replaces all canvases, also those of the regions
        forgetRegions();
        bl_tiles_resize(m_viewId, tileSize);
    }
    m_toEmpty.clear();
    IntRect view { { }, pixelSize };
    if (view.isEmpty() || (view.width() + tileSize - 1) / tileSize > 0x7fff || (view.height() + tileSize - 1) / tileSize > 0x7fff)
        return std::nullopt;
    ++m_frame;

    Vector<IntRect> damaged;
    for (auto& rect : damage.rects()) {
        auto inView = intersection(rect, view);
        if (!inView.isEmpty())
            damaged.append(inView);
    }
    if (damaged.isEmpty())
        return std::nullopt;

    uint64_t maxArea = areaOf(view) / maxTileShare;
    StringBuilder regions;
    StringBuilder drop;
    if (damaged.size() <= maxClusteredRects) {
        updateHotSpots(clustersOf(damaged, tileSize / 4), view, maxArea);
        planRegions(view, maxArea, regions, drop);
    }

    // A region where one holds the damage, otherwise the tiles it touches
    Vector<Tile> tiles;
    Keys chosen;
    auto choose = [&](const Tile& tile) {
        if (chosen.add(tile.key).isNewEntry)
            tiles.append(tile);
    };
    for (auto& rect : damaged) {
        if (auto* region = readyRegionFor(rect)) {
            region->lastUsed = m_frame;
            choose({ region->rect, region->key });
            continue;
        }
        forEachTile(rect, view, tileSize, choose);
    }
    // The view canvas keeps its frame: where damage came since, a canvas has to show the view
    for (auto& rect : damaged)
        m_viewStale.unite(rect);
    if (m_viewStale.rects().size() > maxClusteredRects)
        m_viewStale = WebCore::Region { m_viewStale.bounds() };
    // A canvas showing something the damage touches shows the view no longer as it is: drawn
    // again, or emptied once shown when the canvases of this frame cover all of it the view
    // canvas does not show as it is
    WebCore::Region drawn;
    uint64_t damageArea = 0;
    for (auto& tile : tiles) {
        drawn.unite(tile.rect);
        damageArea += areaOf(tile.rect);
    }
    uint64_t redrawArea = 0;
    for (auto& [key, rect] : m_shown) {
        if (chosen.contains(key) || !std::any_of(damaged.begin(), damaged.end(), [&](auto& damagedRect) { return damagedRect.intersects(rect); }))
            continue;
        WebCore::Region uncovered { rect };
        uncovered.intersect(m_viewStale);
        uncovered.subtract(drawn);
        if (uncovered.isEmpty()) {
            m_toEmpty.append(key);
            continue;
        }
        choose({ rect, key });
        drawn.unite(rect);
        redrawArea += areaOf(rect);
    }

    StringBuilder missing;
    auto ask = makeScopeExit([&] {
        if (missing.isEmpty() && regions.isEmpty() && drop.isEmpty())
            return;
        notifyHost(m_viewId, "tiles", makeString("{\"size\":"_s, m_tileSize, ",\"tiles\":["_s, missing.toString(),
            "],\"regions\":["_s, regions.toString(), "],\"drop\":["_s, drop.toString(), "]}"_s));
    });
    // Canvases drawn again only because they hold older damage beside this one (the tiles under a
    // region that just came, a region larger than its damage now): a whole frame empties them
    if (redrawArea > damageArea) {
        m_toEmpty.clear();
        return std::nullopt;
    }
    uint64_t area = damageArea + redrawArea;
    if (tiles.size() > maxTiles || area > maxArea) {
        m_toEmpty.clear();
        return std::nullopt;
    }
    for (auto& tile : tiles) {
        for (auto& whole : rectsDrawnWhole) {
            if (whole.intersects(tile.rect)) {
                m_toEmpty.clear();
                return std::nullopt;
            }
        }
    }

    bool ready = true;
    for (auto& tile : tiles) {
        if (bl_tile_ready(m_viewId, m_tileSize, tile.key))
            continue;
        ready = false;
        if (!(tile.key & regionKeyBit) && m_requested.add(tile.key).isNewEntry)
            missing.append(missing.isEmpty() ? ""_s : ","_s, tile.key);
    }
    if (!ready) {
        m_toEmpty.clear();
        return std::nullopt;
    }
    return tiles;
}

bool DamageTiles::show(const Tile& tile)
{
    if (!Gpu::showFramebuffer(m_viewId, tile.key))
        return false;
    m_shown.set(tile.key, tile.rect);
    return true;
}

void DamageTiles::didShowTiles()
{
    for (auto key : m_toEmpty) {
        bl_tile_clear(m_viewId, key);
        m_shown.remove(key);
    }
    m_toEmpty.clear();
}

void DamageTiles::didShowWholeFrame()
{
    for (auto key : m_shown.keys())
        bl_tile_clear(m_viewId, key);
    m_shown.clear();
    m_toEmpty.clear();
    m_viewStale = { };
}

void DamageTiles::forgetView(int viewId)
{
    bl_tiles_forget(viewId);
}

} // namespace BrowserLite
