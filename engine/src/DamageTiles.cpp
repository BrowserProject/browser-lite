#include "config.h"
#include "DamageTiles.h"

#include "GpuRaster.h"
#include "Host.h"
#include <WebCore/Damage.h>
#include <WebCore/FloatRect.h>
#include <cmath>
#include <emscripten/emscripten.h>
#include <wtf/text/MakeString.h>
#include <wtf/text/StringBuilder.h>

// In the worker of the compositor (engine-pre.js): Module.blCanvases.get(viewId).tiles holds the
// canvases of the tiles of the current size by key
EM_JS(int, bl_tile_ready, (int viewId, int size, unsigned key), {
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
    var target = Module.blCanvases && Module.blCanvases.get(viewId);
    var tile = target && target.tiles && target.tiles.canvases.get(key);
    if (tile && tile.bitmapContext)
        tile.bitmapContext.transferFromImageBitmap(null);
});

EM_JS(void, bl_tiles_forget, (int viewId), {
    var target = Module.blCanvases && Module.blCanvases.get(viewId);
    if (!target || !target.tiles)
        return;
    target.tiles.canvases.forEach(function (tile) {
        if (tile.bitmapContext)
            tile.bitmapContext.transferFromImageBitmap(null);
    });
    target.tiles = null;
});

namespace BrowserLite {

using namespace WebCore;

// Tiles of 128 CSS pixels: a spinner touches one to four, a 1920x1080 view has 135
static constexpr float tileSizeInCSSPixels = 128;
// A frame shows tiles while they are at most this many and cover at most half of the view: beyond
// that a whole frame costs the host about as much as the small ones (measured under SwiftShader at
// 1920x1080, GPU process CPU per frame: one tile 7.5 ms, four 18 ms, the whole view 100 ms). On a
// phone (393x601 CSS pixels at ratio 2) a spinner on the corner of four tiles covers 28 %.
static constexpr unsigned maxTiles = 16;
static constexpr unsigned maxTileShare = 2;

static unsigned keyOf(int column, int row)
{
    return static_cast<unsigned>(row) << 16 | static_cast<unsigned>(column);
}

std::optional<Vector<DamageTiles::Tile>> DamageTiles::tilesFor(const IntSize& pixelSize, float deviceScaleFactor, const Damage& damage, const Vector<FloatRect>& rectsDrawnWhole)
{
    int tileSize = std::max(64, static_cast<int>(std::lround(tileSizeInCSSPixels * deviceScaleFactor)));
    if (tileSize != m_tileSize) {
        didShowWholeFrame();
        m_tileSize = tileSize;
        m_requested.clear();
        bl_tiles_resize(m_viewId, tileSize);
    }
    IntRect view { { }, pixelSize };
    if (view.isEmpty() || (view.width() + tileSize - 1) / tileSize > 0x7fff || (view.height() + tileSize - 1) / tileSize > 0x7fff)
        return std::nullopt;

    Keys keys;
    Vector<Tile> tiles;
    uint64_t area = 0;
    uint64_t maxArea = static_cast<uint64_t>(view.width()) * view.height() / maxTileShare;
    for (auto& damaged : damage.rects()) {
        auto rect = intersection(damaged, view);
        if (rect.isEmpty())
            continue;
        for (int row = rect.y() / tileSize; row <= (rect.maxY() - 1) / tileSize; ++row) {
            for (int column = rect.x() / tileSize; column <= (rect.maxX() - 1) / tileSize; ++column) {
                auto key = keyOf(column, row);
                if (!keys.add(key).isNewEntry)
                    continue;
                if (keys.size() > maxTiles)
                    return std::nullopt;
                auto tile = intersection(IntRect { column * tileSize, row * tileSize, tileSize, tileSize }, view);
                area += static_cast<uint64_t>(tile.width()) * tile.height();
                if (area > maxArea)
                    return std::nullopt;
                for (auto& whole : rectsDrawnWhole) {
                    if (whole.intersects(tile))
                        return std::nullopt;
                }
                tiles.append({ tile, key });
            }
        }
    }
    if (tiles.isEmpty())
        return std::nullopt;

    StringBuilder missing;
    bool ready = true;
    for (auto& tile : tiles) {
        if (bl_tile_ready(m_viewId, m_tileSize, tile.key))
            continue;
        ready = false;
        if (m_requested.add(tile.key).isNewEntry)
            missing.append(missing.isEmpty() ? ""_s : ","_s, tile.key);
    }
    if (!missing.isEmpty())
        notifyHost(m_viewId, "tiles", makeString("{\"size\":"_s, m_tileSize, ",\"tiles\":["_s, missing.toString(), "]}"_s));
    if (!ready)
        return std::nullopt;
    return tiles;
}

bool DamageTiles::show(const Tile& tile)
{
    if (!Gpu::showFramebuffer(m_viewId, tile.key))
        return false;
    m_shown.add(tile.key);
    return true;
}

void DamageTiles::didShowWholeFrame()
{
    for (auto key : m_shown)
        bl_tile_clear(m_viewId, key);
    m_shown.clear();
}

void DamageTiles::forgetView(int viewId)
{
    bl_tiles_forget(viewId);
}

} // namespace BrowserLite
