// Host layers: a layer that only animates its opacity and its transform (a pulsing skeleton
// placeholder, a blinking or pulsating dot, a spinner that scales) is shown by the host browser itself,
// like Chromium runs such animations on its compositor.
//
// The host browser repaints a canvas whole for every frame it gets: under SwiftShader a page of 46
// pulsing placeholders cost 7.5 CPU cores at 60 frames per second, every frame a whole view, and even
// a 36 px dot that only scales and fades in damage tiles (Wikipedia) 0.8 cores. So once such a layer
// stood still for a while, the compositor asks the host for a canvas of its own (event "layers", the
// core's view-host-layers.ts): the host puts it over the view canvas and runs the layer's opacity and
// transform on it with a Web Animation, sampled from the engine's animation and started at the same
// time. When that canvas arrived, one frame of the compositor draws the layer alone into it and the
// view without it (in the same task of the worker, so the host shows both together); from then on its
// animation changes no frame. A layer whose transform animates is drawn once at the largest scale of
// its animation, and the host scales that picture (like Chromium rasterizes such a layer once at its
// largest scale). Plain layers drawn after it over where it may show (its covers: a dot or an icon on
// a pulsing ring) go into a cover canvas right above its canvas, and the view draws them only outside
// that area. The layer goes back into the frames, again in one task with its canvases emptied, as
// soon as it or a cover moves, is clipped differently, gets covered by any other layer drawn after
// it, its animation changes or ends, or the view gets a new size. New contents of the layer or its
// covers are drawn into their canvas in the frame that brings them.
//
// SkiaCompositingLayer (patches 0104 and 0117) lists the layers that qualify in each frame: leaves
// without effects whose ancestors have none (opacity 1, no filter, mask, blend mode or 3D), drawn axis
// aligned, whose running animations all animate opacity or transform on one timeline, with their
// covers: leaves without animations and effects but a mask under ancestors without effects. The host
// takes a transform animation only if it scales and moves the layer without rotating or mirroring it
// and the layer stays inside its clip all the time (the host does not clip it).
//
// Compositor thread only, one per view (CompositorScene).
#pragma once

#include <WebCore/FloatRect.h>
#include <WebCore/IntRect.h>
#include <WebCore/SkiaCompositingLayer.h>
#include <WebCore/TransformationMatrix.h>
#include <wtf/HashMap.h>
#include <wtf/MonotonicTime.h>
#include <wtf/TZoneMalloc.h>
#include <wtf/UniqueRef.h>
#include <wtf/Vector.h>
#include <wtf/WeakPtr.h>

namespace WebCore {
class Damage;
}

namespace BrowserLite {

class HostLayers {
public:
    // The layer's animation at a running time in seconds: its opacity and its whole transform into the
    // frame, which scales by scaleX and scaleY and then moves by x and y (device pixels)
    struct Sample {
        double time;
        float opacity;
        float scaleX { 1 };
        float scaleY { 1 };
        float x { 0 };
        float y { 0 };
    };

    // A layer drawn after a host layer over it, which the host shows above it (in a canvas of its own
    // where the host layer may show; the frames draw it only outside)
    struct Cover {
        WeakPtr<WebCore::SkiaCompositingLayer> layer;
        WebCore::TransformationMatrix transform;
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
        WTF_MAKE_STRUCT_TZONE_ALLOCATED(Entry);
        WeakPtr<WebCore::SkiaCompositingLayer> layer;
        // Where it is placed (EmbedderLayer), unchanged while it stands still
        WebCore::TransformationMatrix placement;
        WebCore::FloatRect localRect;
        WebCore::IntRect clip;
        unsigned stillFrames { 0 };
        State state { State::Candidate };
        // Sampled (prepare()), or sampled and found unfit for the host (rotated, mirrored or leaving
        // its clip): not again until it moves
        bool prepared { false };
        bool refused { false };
        // Its canvas and the canvas of its covers at the host, and whether they need drawing
        unsigned key { 0 };
        unsigned coverKey { 0 };
        bool needsDraw { false };
        bool needsCoverDraw { false };
        Vector<Cover> covers;
        // Its canvas in frame pixels, the transform its contents are drawn into it with, and where it
        // shows over its whole animation (the canvas unless the transform animates)
        WebCore::IntRect rect;
        WebCore::TransformationMatrix drawTransform;
        WebCore::IntRect bounds;
        // The animation as the host replays it: started at start, samples over two iterations (both
        // directions of an alternating one), linear between them
        MonotonicTime start;
        Seconds duration;
        double iterations { 0 };
        bool animatesTransform { false };
        Vector<Sample> samples;
    };

    void prepare(Entry&, WebCore::SkiaCompositingLayer&, const WebCore::SkiaCompositingLayer::EmbedderLayer&);
    void request(Entry&);
    void show(Entry&, WebCore::SkiaCompositingLayer&, WebCore::Damage*);
    void putBack(Entry&, WebCore::Damage*);
    bool matches(const Entry&, WebCore::SkiaCompositingLayer&, const WebCore::SkiaCompositingLayer::EmbedderLayer&) const;
    void notifyHost();

    int m_viewId;
    unsigned m_nextKey { 1 };
    HashMap<const WebCore::SkiaCompositingLayer*, UniqueRef<Entry>> m_entries;
    // Canvases to empty and forget after the frame
    Vector<unsigned> m_forget;
    // Keys whose canvas the host has to make (sent with the next event)
    Vector<unsigned> m_added;
    bool m_changed { false };
};

} // namespace BrowserLite
