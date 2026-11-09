// Host layers: a layer that only animates its opacity (a pulsing skeleton placeholder, a blinking
// dot) is shown by the host browser itself, like Chromium runs such animations on its compositor.
//
// The host browser repaints a canvas whole for every frame it gets: under SwiftShader a page of 46
// pulsing placeholders cost 7.5 CPU cores at 60 frames per second, every frame a whole view. So
// once such a layer stood still for a while, the compositor asks the host for a canvas of its own
// (event "layers", the core's view-tiles.ts): the host puts it over the view canvas where the layer
// shows and runs the layer's opacity on it with a Web Animation, sampled from the engine's
// animation and started at the same time. When that canvas arrived, one frame of the compositor
// draws the layer alone into it and the view without it (in the same task of the worker, so the
// host shows both together); from then on its opacity changes no frame. The layer goes back into the
// frames, again in one task with its canvas emptied, as soon as it moves, is clipped differently,
// gets covered by a layer drawn after it, its animation changes or ends, or the view gets a new size.
// New contents of the layer are drawn into its canvas in the frame that brings them.
//
// SkiaCompositingLayer (patch 0104) lists the layers that qualify in each frame: leaves without
// effects whose ancestors have none (opacity 1, no filter, mask, blend mode or 3D), drawn axis
// aligned, with a single running opacity animation.
//
// Compositor thread only, one per view (CompositorScene).
#pragma once

#include <WebCore/FloatRect.h>
#include <WebCore/IntRect.h>
#include <WebCore/SkiaCompositingLayer.h>
#include <wtf/HashMap.h>
#include <wtf/MonotonicTime.h>
#include <wtf/Vector.h>
#include <wtf/WeakPtr.h>

namespace WebCore {
class Damage;
}

namespace BrowserLite {

class HostLayers {
public:
    // The opacity of a layer's animation at a running time in seconds
    struct Sample {
        double time;
        float opacity;
    };

    explicit HostLayers(int viewId)
        : m_viewId(viewId)
    {
    }

    // Before the frame is drawn: decides which of the layers the frame lists the host shows from now
    // on and which go back into the frame, and adds the places of both to the frame damage. allowed
    // false (a new view size, no damage tracking, BL_HOST_LAYERS=0) puts all back into the frame.
    void update(Vector<WebCore::SkiaCompositingLayer::EmbedderLayer>&, WebCore::Damage* frameDamage, bool allowed);
    // After the frame is shown, in the same task: draws the layers the host shows newly or with new
    // contents into their canvases and empties the canvases of the layers back in the frame.
    void present(WebCore::SkiaCompositingLayer& root);
    // The view stops compositing: all canvases empty and forgotten, also at the host
    static void forgetView(int viewId);

private:
    enum class State : uint8_t { Candidate, Requested, Shown };
    struct Entry {
        WeakPtr<WebCore::SkiaCompositingLayer> layer;
        WebCore::IntRect rect;
        WebCore::FloatRect paintedRect;
        unsigned stillFrames { 0 };
        State state { State::Candidate };
        unsigned key { 0 };
        bool needsDraw { false };
        // The animation as the host replays it: started at start, samples of its opacity over two
        // iterations (both directions of an alternating one), linear between them
        MonotonicTime start;
        Seconds duration;
        double iterations { 0 };
        Vector<Sample> samples;
    };

    void request(Entry&, WebCore::SkiaCompositingLayer&);
    void show(Entry&, WebCore::SkiaCompositingLayer&, WebCore::Damage*);
    void putBack(Entry&, WebCore::Damage*);
    bool matches(const Entry&, WebCore::SkiaCompositingLayer&, float opacity) const;
    void notifyHost();

    int m_viewId;
    unsigned m_nextKey { 1 };
    HashMap<const WebCore::SkiaCompositingLayer*, Entry> m_entries;
    // Canvases to empty and forget after the frame
    Vector<unsigned> m_forget;
    // Keys whose canvas the host has to make (sent with the next event)
    Vector<unsigned> m_added;
    bool m_changed { false };
};

} // namespace BrowserLite
