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

// A layer the host shows has stood still for this many frames (about 0.3 s at 60 frames per
// second): while a page scrolls or moves it, it stays in the frames, which are whole then anyway
static constexpr unsigned stillFramesBeforeHost = 20;
// Canvases at the host per view at most
static constexpr unsigned maxLayers = 64;
// Samples of the opacity per second of the animation (the host interpolates linearly between them),
// and per iteration at least and at most. Between two samples where the opacity deviates from that
// line by more than sampleTolerance (steps, sharp curves) more come, halving the gap, at most
// maxRefinement times.
static constexpr double samplesPerSecond = 30;
static constexpr unsigned minSamples = 8;
static constexpr unsigned maxSamples = 120;
static constexpr float sampleTolerance = 0.004;
static constexpr unsigned maxRefinement = 10;
// What the host shows and what the engine computes for the frame may differ this much, more
// means the animation changed (paused, replaced, restarted)
static constexpr float opacityTolerance = 0.02;
static constexpr Seconds startTolerance = 20_ms;

static unsigned samplesPerIteration(Seconds duration)
{
    return std::clamp(static_cast<unsigned>(std::ceil(duration.seconds() * samplesPerSecond)), minSamples, maxSamples);
}

// Running time to the opacity the host shows then: the samples cover two iterations
static float sampledOpacity(const Vector<HostLayers::Sample>& samples, Seconds duration, Seconds elapsed)
{
    double time = std::fmod(elapsed.seconds(), 2 * duration.seconds());
    auto next = std::upper_bound(samples.begin(), samples.end(), time, [](double time, auto& sample) {
        return time < sample.time;
    });
    if (next == samples.begin())
        return samples.first().opacity;
    if (next == samples.end())
        return samples.last().opacity;
    auto& before = *(next - 1);
    double gap = next->time - before.time;
    float fraction = gap > 0 ? static_cast<float>((time - before.time) / gap) : 1;
    return before.opacity + (next->opacity - before.opacity) * fraction;
}

// Samples between two that the line between them does not follow closely enough
static void refine(SkiaCompositingLayer& layer, const HostLayers::Sample& from, const HostLayers::Sample& to, unsigned depth, Vector<HostLayers::Sample>& samples)
{
    HostLayers::Sample middle { (from.time + to.time) / 2, 0 };
    middle.opacity = layer.opacityAt(Seconds(middle.time));
    if (depth >= maxRefinement || std::abs(middle.opacity - (from.opacity + to.opacity) / 2) <= sampleTolerance)
        return;
    refine(layer, from, middle, depth + 1, samples);
    samples.append(middle);
    refine(layer, middle, to, depth + 1, samples);
}

bool HostLayers::matches(const Entry& entry, SkiaCompositingLayer& layer, float opacity) const
{
    auto animation = layer.opacityAnimation();
    if (!animation || animation->duration != entry.duration || animation->iterations != entry.iterations)
        return false;
    if (std::abs((animation->start - entry.start).seconds()) > startTolerance.seconds())
        return false;
    return std::abs(sampledOpacity(entry.samples, entry.duration, animation->elapsed) - opacity) <= opacityTolerance;
}

void HostLayers::request(Entry& entry, SkiaCompositingLayer& layer)
{
    auto animation = layer.opacityAnimation();
    if (!animation)
        return;
    entry.start = animation->start;
    entry.duration = animation->duration;
    entry.iterations = animation->iterations;
    unsigned perIteration = samplesPerIteration(animation->duration);
    entry.samples.clear();
    for (unsigned i = 0; i <= 2 * perIteration; ++i) {
        Sample sample { animation->duration.seconds() * i / perIteration, 0 };
        sample.opacity = layer.opacityAt(Seconds(sample.time));
        if (i) {
            auto previous = entry.samples.last();
            refine(layer, previous, sample, 0, entry.samples);
        }
        entry.samples.append(sample);
    }
    entry.key = m_nextKey++;
    entry.state = State::Requested;
    bl_host_layer_expect(m_viewId, entry.key);
    m_added.append(entry.key);
    m_changed = true;
}

void HostLayers::show(Entry& entry, SkiaCompositingLayer& layer, Damage* frameDamage)
{
    layer.setDrawnByEmbedder(true);
    if (frameDamage)
        frameDamage->add(entry.rect);
    entry.state = State::Shown;
    entry.needsDraw = true;
}

// The layer goes back into the frames (where it was shown, and where it is now, which the frame does
// not track while the host shows it); a canvas asked for or shown is emptied and forgotten
void HostLayers::putBack(Entry& entry, Damage* frameDamage)
{
    if (entry.state == State::Shown) {
        if (auto* layer = entry.layer.get())
            layer->setDrawnByEmbedder(false);
        if (frameDamage)
            frameDamage->add(entry.rect);
    }
    if (entry.state != State::Candidate) {
        m_forget.append(entry.key);
        m_added.removeFirst(entry.key);
        m_changed = true;
    }
    entry.state = State::Candidate;
    entry.key = 0;
    entry.stillFrames = 0;
    entry.needsDraw = false;
}

void HostLayers::update(Vector<SkiaCompositingLayer::EmbedderLayer>& layers, Damage* frameDamage, bool allowed)
{
    if (!allowed || !frameDamage) {
        for (auto& entry : m_entries.values())
            putBack(entry, frameDamage);
        m_entries.clear();
        return;
    }

    unsigned inUse = 0;
    for (auto& entry : m_entries.values())
        inUse += entry.state != State::Candidate;

    HashSet<const SkiaCompositingLayer*> listed;
    for (auto& listedLayer : layers) {
        auto& layer = listedLayer.layer.get();
        auto iterator = m_entries.find(&layer);
        // A new layer where a destroyed one was
        if (iterator != m_entries.end() && iterator->value.layer.get() != &layer) {
            inUse -= iterator->value.state != State::Candidate;
            putBack(iterator->value, frameDamage);
            m_entries.remove(iterator);
            iterator = m_entries.end();
        }
        listed.add(&layer);
        if (iterator == m_entries.end()) {
            Entry entry;
            entry.layer = WeakPtr<SkiaCompositingLayer> { layer };
            entry.rect = listedLayer.rect;
            entry.paintedRect = listedLayer.paintedRect;
            m_entries.add(&layer, WTF::move(entry));
            continue;
        }
        auto& entry = iterator->value;
        bool still = entry.rect == listedLayer.rect && entry.paintedRect == listedLayer.paintedRect;
        if (entry.state == State::Shown && still && !listedLayer.overlapped && matches(entry, layer, listedLayer.opacity)) {
            entry.needsDraw |= listedLayer.changed;
            continue;
        }
        if (!still || listedLayer.overlapped || entry.state == State::Shown) {
            inUse -= entry.state != State::Candidate;
            // Shown until now: also where it is now, the frame did not track it
            if (entry.state == State::Shown && frameDamage)
                frameDamage->add(listedLayer.rect);
            putBack(entry, frameDamage);
            entry.rect = listedLayer.rect;
            entry.paintedRect = listedLayer.paintedRect;
            continue;
        }
        ++entry.stillFrames;
        if (entry.state == State::Candidate) {
            if (entry.stillFrames >= stillFramesBeforeHost && inUse < maxLayers && Gpu::hasCanvas(m_viewId)) {
                request(entry, layer);
                inUse += entry.state != State::Candidate;
            }
            continue;
        }
        if (!bl_host_layer_ready(m_viewId, entry.key))
            continue;
        if (matches(entry, layer, listedLayer.opacity))
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
        putBack(keyAndEntry.value, frameDamage);
        return true;
    });
}

void HostLayers::present(SkiaCompositingLayer& root)
{
    auto* grContext = Gpu::context();
    for (auto& entry : m_entries.values()) {
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
        root.drawEmbedderLayer(*canvas, *layer);
        canvas->restore();
        grContext->flushAndSubmit(surface.get());
        Gpu::showFramebufferInLayer(m_viewId, entry.key);
        entry.needsDraw = false;
    }
    for (auto key : std::exchange(m_forget, { }))
        bl_host_layer_forget(m_viewId, key);
    if (std::exchange(m_changed, false))
        notifyHost();
}

// {keep: [key], add: [{key, x, y, width, height, period, iterations, start, times: [ms], opacity:
// [sample]}]}: the host keeps the canvases of keep and add and removes all others. A layer of add
// covers x, y, width and height in frame pixels of the view canvas; its opacity runs linearly
// through the samples at their times (from 0 to period ms), iterations times (null: infinitely),
// from start (ms since 1970).
void HostLayers::notifyHost()
{
    double epochNow = bl_host_epoch_ms();
    auto now = MonotonicTime::now();
    StringBuilder keep;
    StringBuilder add;
    for (auto& entry : m_entries.values()) {
        if (entry.state == State::Candidate)
            continue;
        if (!m_added.contains(entry.key)) {
            keep.append(keep.isEmpty() ? ""_s : ","_s, entry.key);
            continue;
        }
        StringBuilder times;
        StringBuilder samples;
        for (auto& sample : entry.samples) {
            times.append(times.isEmpty() ? ""_s : ","_s, String::number(std::round(sample.time * 1e6) / 1e3));
            samples.append(samples.isEmpty() ? ""_s : ","_s, String::number(std::round(sample.opacity * 10000) / 10000));
        }
        auto& rect = entry.rect;
        double start = epochNow - (now - entry.start).milliseconds();
        auto iterations = std::isinf(entry.iterations) ? String("null"_s) : String::number(entry.iterations / 2);
        add.append(add.isEmpty() ? ""_s : ","_s, "{\"key\":"_s, entry.key, ",\"x\":"_s, rect.x(), ",\"y\":"_s, rect.y(), ",\"width\":"_s, rect.width(),
            ",\"height\":"_s, rect.height(), ",\"period\":"_s, String::number((entry.duration * 2).milliseconds()), ",\"iterations\":"_s, iterations,
            ",\"start\":"_s, String::number(start), ",\"times\":["_s, times.toString(), "],\"opacity\":["_s, samples.toString(), "]}"_s);
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
