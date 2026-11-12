#include "config.h"
#include "HostLayers.h"

#include "GpuRaster.h"
#include "Host.h"
#include <WebCore/Damage.h>
#include <algorithm>
#include <cmath>
#include <emscripten/emscripten.h>
#include <skia/core/SkCanvas.h>
#include <skia/core/SkSurface.h>
#include <skia/gpu/ganesh/GrDirectContext.h>
#include <wtf/HashSet.h>
#include <wtf/TZoneMallocInlines.h>
#include <wtf/text/MakeString.h>
#include <wtf/text/StringBuilder.h>

// In the worker of the compositor (engine-pre.js): Module.blCanvases.get(viewId).layers holds the
// keys asked of the host (wanted) and the canvases it sent for them (canvases)
EM_JS(void, bl_host_layer_expect, (int viewId, unsigned key), {
    var target = Module.blCanvases && Module.blCanvases.get(viewId);
    if (!target)
        return;
    if (!target.layers)
        target.layers = { wanted: new Set(), canvases: new Map() };
    target.layers.wanted.add(key);
});

EM_JS(int, bl_host_layer_ready, (int viewId, unsigned key), {
    var target = Module.blCanvases && Module.blCanvases.get(viewId);
    return target && target.layers && target.layers.canvases.has(key) ? 1 : 0;
});

// An empty canvas shows the view canvas underneath
EM_JS(void, bl_host_layer_forget, (int viewId, unsigned key), {
    var target = Module.blCanvases && Module.blCanvases.get(viewId);
    var layers = target && target.layers;
    if (!layers)
        return;
    var layer = layers.canvases.get(key);
    if (layer && layer.bitmapContext)
        Module.blEmptyBitmap(layer.bitmapContext);
    layers.canvases.delete(key);
    layers.wanted.delete(key);
});

EM_JS(void, bl_host_layers_forget, (int viewId), {
    var target = Module.blCanvases && Module.blCanvases.get(viewId);
    if (!target || !target.layers)
        return;
    target.layers.canvases.forEach(function (layer) {
        if (layer.bitmapContext)
            Module.blEmptyBitmap(layer.bitmapContext);
    });
    target.layers = null;
});

// Milliseconds since 1970 as the host counts them (performance.timeOrigin is that of this worker)
EM_JS(double, bl_host_epoch_ms, (), {
    return performance.timeOrigin + performance.now();
});

namespace BrowserLite {

using namespace WebCore;

WTF_MAKE_STRUCT_TZONE_ALLOCATED_IMPL(HostLayers::Entry);

// A layer the host shows has stood still for this many frames (about 0.3 s at 60 frames per
// second): while a page scrolls or moves it, it stays in the frames, which are whole then anyway
static constexpr unsigned stillFramesBeforeHost = 20;
// Canvases at the host per view at most
static constexpr unsigned maxLayers = 64;
// Samples of the animation per second (the host interpolates linearly between them), and per
// iteration at least and at most. Between two samples where the animation deviates from that line by
// more than sampleTolerance in opacity or samplePixels in place (steps, sharp curves) more come,
// halving the gap, at most maxRefinement times.
static constexpr double samplesPerSecond = 30;
static constexpr unsigned minSamples = 8;
static constexpr unsigned maxSamples = 120;
static constexpr float sampleTolerance = 0.004;
static constexpr float samplePixels = 0.25;
static constexpr unsigned maxRefinement = 10;
// What the host shows and what the engine computes for the frame may differ this much, more
// means the animation changed (paused, replaced, restarted)
static constexpr float opacityTolerance = 0.02;
static constexpr float placeTolerance = 1;
static constexpr Seconds startTolerance = 20_ms;

static unsigned samplesPerIteration(Seconds duration)
{
    return std::clamp(static_cast<unsigned>(std::ceil(duration.seconds() * samplesPerSecond)), minSamples, maxSamples);
}

// The scale and offset of a transform (its rotation and skew are checked elsewhere)
static HostLayers::Sample sampleFrom(double time, float opacity, const TransformationMatrix& transform)
{
    return { time, opacity, static_cast<float>(transform.a()), static_cast<float>(transform.d()), static_cast<float>(transform.e()), static_cast<float>(transform.f()) };
}

static HostLayers::Sample sampleOf(SkiaCompositingLayer& layer, double time)
{
    auto state = layer.animatedStateAt(Seconds(time));
    return sampleFrom(time, state.opacity, state.transform);
}

// What the host shows at a running time: the samples cover two iterations, linear between them
static HostLayers::Sample sampleAt(const Vector<HostLayers::Sample>& samples, Seconds duration, Seconds elapsed)
{
    double time = std::fmod(elapsed.seconds(), 2 * duration.seconds());
    auto next = std::upper_bound(samples.begin(), samples.end(), time, [](double time, auto& sample) {
        return time < sample.time;
    });
    if (next == samples.begin())
        return samples.first();
    if (next == samples.end())
        return samples.last();
    auto& before = *(next - 1);
    double gap = next->time - before.time;
    float fraction = gap > 0 ? static_cast<float>((time - before.time) / gap) : 1;
    auto mix = [&](float from, float to) {
        return from + (to - from) * fraction;
    };
    return { time, mix(before.opacity, next->opacity), mix(before.scaleX, next->scaleX), mix(before.scaleY, next->scaleY), mix(before.x, next->x), mix(before.y, next->y) };
}

// How far apart the edges of the layer's rect are in two samples, in device pixels
static float distance(const HostLayers::Sample& a, const HostLayers::Sample& b, const FloatRect& rect)
{
    auto edge = [](float scaleA, float offsetA, float scaleB, float offsetB, float at) {
        return std::abs(scaleA * at + offsetA - scaleB * at - offsetB);
    };
    return std::max({ edge(a.scaleX, a.x, b.scaleX, b.x, rect.x()), edge(a.scaleX, a.x, b.scaleX, b.x, rect.maxX()),
        edge(a.scaleY, a.y, b.scaleY, b.y, rect.y()), edge(a.scaleY, a.y, b.scaleY, b.y, rect.maxY()) });
}

// Samples between two that the line between them does not follow closely enough
static void refine(SkiaCompositingLayer& layer, const FloatRect& rect, const HostLayers::Sample& from, const HostLayers::Sample& to, unsigned depth, Vector<HostLayers::Sample>& samples)
{
    auto middle = sampleOf(layer, (from.time + to.time) / 2);
    HostLayers::Sample line { middle.time, (from.opacity + to.opacity) / 2, (from.scaleX + to.scaleX) / 2, (from.scaleY + to.scaleY) / 2, (from.x + to.x) / 2, (from.y + to.y) / 2 };
    if (depth >= maxRefinement || (std::abs(middle.opacity - line.opacity) <= sampleTolerance && distance(middle, line, rect) <= samplePixels))
        return;
    refine(layer, rect, from, middle, depth + 1, samples);
    samples.append(middle);
    refine(layer, rect, middle, to, depth + 1, samples);
}

// The layer's rect in the frame under a transform, also when it is scaled to nothing
static FloatRect mapped(const HostLayers::Sample& sample, const FloatRect& rect)
{
    return { sample.scaleX * rect.x() + sample.x, sample.scaleY * rect.y() + sample.y, sample.scaleX * rect.width(), sample.scaleY * rect.height() };
}

bool HostLayers::matches(const Entry& entry, SkiaCompositingLayer& layer, const SkiaCompositingLayer::EmbedderLayer& listed) const
{
    auto animation = layer.embedderAnimation();
    if (!animation || animation->duration != entry.duration || animation->iterations != entry.iterations || animation->animatesTransform != entry.animatesTransform)
        return false;
    if (std::abs((animation->start - entry.start).seconds()) > startTolerance.seconds())
        return false;
    auto shown = sampleAt(entry.samples, entry.duration, animation->elapsed);
    if (std::abs(shown.opacity - listed.opacity) > opacityTolerance)
        return false;
    if (!entry.animatesTransform)
        return true;
    auto& transform = listed.transform;
    return !transform.b() && !transform.c() && distance(shown, sampleFrom(0, listed.opacity, transform), entry.localRect) <= placeTolerance;
}

// Samples the animation and decides where the host would show the layer; from then on later layers
// over any of that are its covers or keep it in the frames
void HostLayers::prepare(Entry& entry, SkiaCompositingLayer& layer, const SkiaCompositingLayer::EmbedderLayer& listed)
{
    auto animation = layer.embedderAnimation();
    if (!animation)
        return;
    entry.start = animation->start;
    entry.duration = animation->duration;
    entry.iterations = animation->iterations;
    entry.animatesTransform = animation->animatesTransform;
    // A layer whose transform stays needs no samples of it
    auto rectFor = entry.animatesTransform ? entry.localRect : FloatRect { };
    unsigned perIteration = samplesPerIteration(animation->duration);
    entry.samples.clear();
    for (unsigned i = 0; i <= 2 * perIteration; ++i) {
        auto sample = sampleOf(layer, animation->duration.seconds() * i / perIteration);
        if (i) {
            auto previous = entry.samples.last();
            refine(layer, rectFor, previous, sample, 0, entry.samples);
        }
        entry.samples.append(sample);
    }

    entry.refused = true;
    if (!entry.animatesTransform) {
        entry.drawTransform = listed.transform;
        entry.rect = enclosingIntRect(listed.transform.mapRect(entry.localRect));
        entry.rect.intersect(entry.clip);
        entry.bounds = entry.rect;
    } else {
        // Scaled and moved only, and inside its clip all the time: drawn at its largest scale
        std::optional<FloatRect> bounds;
        const Sample* largest = nullptr;
        for (auto& sample : entry.samples) {
            if (sample.scaleX < 0 || sample.scaleY < 0)
                return;
            auto rect = mapped(sample, entry.localRect);
            if (bounds)
                bounds->uniteEvenIfEmpty(rect);
            else
                bounds = rect;
            if (!largest || sample.scaleX * sample.scaleY > largest->scaleX * largest->scaleY)
                largest = &sample;
        }
        auto drawn = layer.animatedStateAt(Seconds(largest->time)).transform;
        entry.bounds = enclosingIntRect(*bounds);
        entry.rect = enclosingIntRect(drawn.mapRect(entry.localRect));
        if (largest->scaleX <= 0 || largest->scaleY <= 0 || drawn.b() || drawn.c() || !entry.clip.contains(entry.bounds))
            return;
        entry.drawTransform = drawn;
    }
    if (entry.rect.isEmpty())
        return;
    entry.refused = false;
    entry.prepared = true;
    layer.setEmbedderBounds(entry.bounds);
}

void HostLayers::request(Entry& entry)
{
    entry.key = m_nextKey++;
    bl_host_layer_expect(m_viewId, entry.key);
    m_added.append(entry.key);
    if (!entry.covers.isEmpty()) {
        entry.coverKey = m_nextKey++;
        bl_host_layer_expect(m_viewId, entry.coverKey);
    }
    entry.state = State::Requested;
    m_changed = true;
}

void HostLayers::show(Entry& entry, SkiaCompositingLayer& layer, Damage* frameDamage)
{
    layer.setDrawnByEmbedder(true);
    for (auto& cover : entry.covers) {
        if (auto* coverLayer = cover.layer.get())
            coverLayer->addEmbedderClipOut(entry.bounds);
    }
    if (frameDamage)
        frameDamage->add(entry.bounds);
    entry.state = State::Shown;
    entry.needsDraw = true;
    entry.needsCoverDraw = true;
}

// The layer goes back into the frames (where it was shown, and where it is now, which the frame does
// not track while the host shows it); canvases asked for or shown are emptied and forgotten
void HostLayers::putBack(Entry& entry, Damage* frameDamage)
{
    auto* layer = entry.layer.get();
    if (entry.state == State::Shown) {
        if (layer)
            layer->setDrawnByEmbedder(false);
        for (auto& cover : entry.covers) {
            if (auto* coverLayer = cover.layer.get())
                coverLayer->removeEmbedderClipOut(entry.bounds);
        }
        if (frameDamage)
            frameDamage->add(entry.bounds);
    }
    if (entry.prepared && layer)
        layer->setEmbedderBounds({ });
    if (entry.state != State::Candidate) {
        for (auto key : { entry.key, entry.coverKey }) {
            if (!key)
                continue;
            m_forget.append(key);
            m_added.removeFirst(key);
        }
        m_changed = true;
    }
    entry.state = State::Candidate;
    entry.prepared = false;
    entry.refused = false;
    entry.key = 0;
    entry.coverKey = 0;
    entry.stillFrames = 0;
    entry.needsDraw = false;
}

// The covers of a frame are those the entry knows: the same layers with the same transforms
static bool sameCovers(const Vector<HostLayers::Cover>& covers, const Vector<SkiaCompositingLayer::EmbedderLayer::Cover>& listed)
{
    if (covers.size() != listed.size())
        return false;
    for (size_t i = 0; i < covers.size(); ++i) {
        if (covers[i].layer.get() != listed[i].layer.ptr() || covers[i].transform != listed[i].transform)
            return false;
    }
    return true;
}

void HostLayers::update(Vector<SkiaCompositingLayer::EmbedderLayer>& layers, Damage* frameDamage, bool allowed)
{
    if (!allowed || !frameDamage) {
        for (auto& entry : m_entries.values())
            putBack(entry.get(), frameDamage);
        m_entries.clear();
        return;
    }

    unsigned inUse = 0;
    for (auto& entry : m_entries.values())
        inUse += entry->state != State::Candidate;

    auto place = [](Entry& entry, const SkiaCompositingLayer::EmbedderLayer& listed) {
        entry.placement = listed.placement;
        entry.localRect = listed.localRect;
        entry.clip = listed.clip;
    };
    auto takeCovers = [](Entry& entry, const SkiaCompositingLayer::EmbedderLayer& listed) {
        entry.covers = listed.covers.map([](auto& cover) {
            return Cover { WeakPtr<SkiaCompositingLayer> { cover.layer.get() }, cover.transform };
        });
    };
    HashSet<const SkiaCompositingLayer*> listed;
    for (auto& listedLayer : layers) {
        auto& layer = listedLayer.layer.get();
        auto iterator = m_entries.find(&layer);
        // A new layer where a destroyed one was
        if (iterator != m_entries.end() && iterator->value->layer.get() != &layer) {
            inUse -= iterator->value->state != State::Candidate;
            putBack(iterator->value.get(), frameDamage);
            m_entries.remove(iterator);
            iterator = m_entries.end();
        }
        listed.add(&layer);
        if (iterator == m_entries.end()) {
            auto entry = makeUniqueRef<Entry>();
            entry->layer = WeakPtr<SkiaCompositingLayer> { layer };
            place(entry.get(), listedLayer);
            m_entries.add(&layer, WTF::move(entry));
            continue;
        }
        auto& entry = iterator->value.get();
        bool still = entry.placement == listedLayer.placement && entry.localRect == listedLayer.localRect && entry.clip == listedLayer.clip;
        bool covered = sameCovers(entry.covers, listedLayer.covers);
        if (entry.state == State::Shown && still && covered && !listedLayer.overlapped && matches(entry, layer, listedLayer)) {
            entry.needsDraw |= listedLayer.changed;
            for (auto& cover : listedLayer.covers)
                entry.needsCoverDraw |= cover.changed;
            continue;
        }
        if (!still || listedLayer.overlapped || entry.state == State::Shown || (entry.state == State::Requested && !covered)) {
            inUse -= entry.state != State::Candidate;
            // Shown until now: also where it is now, the frame did not track it
            if (entry.state == State::Shown && frameDamage) {
                auto now = enclosingIntRect(listedLayer.transform.mapRect(listedLayer.localRect));
                now.intersect(listedLayer.clip);
                frameDamage->add(now);
            }
            putBack(entry, frameDamage);
            place(entry, listedLayer);
            continue;
        }
        if (entry.refused)
            continue;
        // Sampled first, its covers then come from the frames that know where it may show
        if (!entry.prepared) {
            prepare(entry, layer, listedLayer);
            continue;
        }
        if (!covered) {
            takeCovers(entry, listedLayer);
            entry.stillFrames = 0;
            continue;
        }
        ++entry.stillFrames;
        if (entry.state == State::Candidate) {
            if (entry.stillFrames >= stillFramesBeforeHost && inUse < maxLayers && Gpu::hasCanvas(m_viewId)) {
                request(entry);
                ++inUse;
            }
            continue;
        }
        if (!bl_host_layer_ready(m_viewId, entry.key) || (entry.coverKey && !bl_host_layer_ready(m_viewId, entry.coverKey)))
            continue;
        if (matches(entry, layer, listedLayer))
            show(entry, layer, frameDamage);
        else {
            --inUse;
            putBack(entry, frameDamage);
        }
    }
    // Layers the frame no longer lists (gone, hidden, moved under an effect)
    m_entries.removeIf([&](auto& keyAndEntry) {
        if (listed.contains(keyAndEntry.key))
            return false;
        putBack(keyAndEntry.value.get(), frameDamage);
        return true;
    });
}

void HostLayers::present(SkiaCompositingLayer& root)
{
    auto* grContext = Gpu::context();
    for (auto& entryRef : m_entries.values()) {
        auto& entry = entryRef.get();
        if (entry.state != State::Shown || !entry.needsDraw)
            continue;
        auto* layer = entry.layer.get();
        auto surface = layer && grContext ? Gpu::framebufferSurface(m_viewId, entry.rect.width(), entry.rect.height()) : nullptr;
        if (!surface)
            continue;
        auto* canvas = surface->getCanvas();
        canvas->clear(SK_ColorTRANSPARENT);
        canvas->save();
        canvas->translate(-entry.rect.x(), -entry.rect.y());
        root.drawEmbedderLayer(*canvas, *layer, entry.drawTransform);
        canvas->restore();
        grContext->flushAndSubmit(surface.get());
        Gpu::showFramebufferInLayer(m_viewId, entry.key);
        entry.needsDraw = false;
    }
    // The covers, drawn alone where the layer may show
    for (auto& entryRef : m_entries.values()) {
        auto& entry = entryRef.get();
        if (entry.state != State::Shown || !entry.needsCoverDraw || !entry.coverKey)
            continue;
        auto surface = grContext ? Gpu::framebufferSurface(m_viewId, entry.bounds.width(), entry.bounds.height()) : nullptr;
        if (!surface)
            continue;
        auto* canvas = surface->getCanvas();
        canvas->clear(SK_ColorTRANSPARENT);
        canvas->save();
        canvas->translate(-entry.bounds.x(), -entry.bounds.y());
        for (auto& cover : entry.covers) {
            if (auto* coverLayer = cover.layer.get())
                root.drawEmbedderLayer(*canvas, *coverLayer, cover.transform);
        }
        canvas->restore();
        grContext->flushAndSubmit(surface.get());
        Gpu::showFramebufferInLayer(m_viewId, entry.coverKey);
        entry.needsCoverDraw = false;
    }
    for (auto key : std::exchange(m_forget, { }))
        bl_host_layer_forget(m_viewId, key);
    if (std::exchange(m_changed, false))
        notifyHost();
}

// {keep: [key], add: [{key, x, y, width, height, period?, iterations?, start?, times?: [ms], opacity?:
// [sample], transform?: [scaleX, scaleY, x, y per sample]}]}: the host keeps the canvases of keep and
// add and removes all others. A layer of add covers x, y, width and height in frame pixels of the
// view canvas, above the layers added before it; its opacity (and transform: scaled from its top left
// corner, then moved by x and y frame pixels) runs linearly through the samples at their times (from
// 0 to period ms), iterations times (null: infinitely), from start (ms since 1970). One without
// times (the covers of a layer) shows its canvas as it is.
void HostLayers::notifyHost()
{
    double epochNow = bl_host_epoch_ms();
    auto now = MonotonicTime::now();
    StringBuilder keep;
    StringBuilder add;
    for (auto& entryRef : m_entries.values()) {
        auto& entry = entryRef.get();
        if (entry.state == State::Candidate)
            continue;
        if (!m_added.contains(entry.key)) {
            keep.append(keep.isEmpty() ? ""_s : ","_s, entry.key);
            if (entry.coverKey)
                keep.append(","_s, entry.coverKey);
            continue;
        }
        auto& rect = entry.rect;
        StringBuilder times;
        StringBuilder samples;
        StringBuilder transforms;
        auto& drawn = entry.drawTransform;
        for (auto& sample : entry.samples) {
            times.append(times.isEmpty() ? ""_s : ","_s, String::number(std::round(sample.time * 1e6) / 1e3));
            samples.append(samples.isEmpty() ? ""_s : ","_s, String::number(std::round(sample.opacity * 10000) / 10000));
            if (!entry.animatesTransform)
                continue;
            // From the canvas as drawn (drawTransform) to the sample, relative to the canvas's corner
            double scaleX = sample.scaleX / drawn.a();
            double scaleY = sample.scaleY / drawn.d();
            double x = scaleX * (rect.x() - drawn.e()) + sample.x - rect.x();
            double y = scaleY * (rect.y() - drawn.f()) + sample.y - rect.y();
            transforms.append(transforms.isEmpty() ? ""_s : ","_s, String::number(std::round(scaleX * 1e5) / 1e5), ","_s,
                String::number(std::round(scaleY * 1e5) / 1e5), ","_s, String::number(std::round(x * 1000) / 1000), ","_s, String::number(std::round(y * 1000) / 1000));
        }
        double start = epochNow - (now - entry.start).milliseconds();
        auto iterations = std::isinf(entry.iterations) ? String("null"_s) : String::number(entry.iterations / 2);
        add.append(add.isEmpty() ? ""_s : ","_s, "{\"key\":"_s, entry.key, ",\"x\":"_s, rect.x(), ",\"y\":"_s, rect.y(), ",\"width\":"_s, rect.width(),
            ",\"height\":"_s, rect.height(), ",\"period\":"_s, String::number((entry.duration * 2).milliseconds()), ",\"iterations\":"_s, iterations,
            ",\"start\":"_s, String::number(start), ",\"times\":["_s, times.toString(), "],\"opacity\":["_s, samples.toString(), "]"_s,
            entry.animatesTransform ? makeString(",\"transform\":["_s, transforms.toString(), ']') : String(), '}');
        // Its covers right after it, so above it
        if (entry.coverKey) {
            auto& bounds = entry.bounds;
            add.append(",{\"key\":"_s, entry.coverKey, ",\"x\":"_s, bounds.x(), ",\"y\":"_s, bounds.y(), ",\"width\":"_s, bounds.width(),
                ",\"height\":"_s, bounds.height(), '}');
        }
    }
    m_added.clear();
    BrowserLite::notifyHost(m_viewId, "layers", makeString("{\"keep\":["_s, keep.toString(), "],\"add\":["_s, add.toString(), "]}"_s));
}

void HostLayers::forgetView(int viewId)
{
    bl_host_layers_forget(viewId);
    BrowserLite::notifyHost(viewId, "layers", "{\"keep\":[],\"add\":[]}"_s);
}

} // namespace BrowserLite
