// VideoFrame fuer browser-lite (WebCodecs, <video> -> VideoFrame, Canvas).
//
// Die Pixel liegen im Speicher der Engine, in einem Block mit allen Ebenen
// dicht hintereinander (so wie VideoFrame.copyTo() sie ohne Layout liefert):
// I420 = Y, U, V; NV12 = Y, UV; RGBA usw. = eine Ebene. Zum Zeichnen rechnen
// wir einmal nach RGBA um und behalten das Bild (SkImage, darf in jeden Thread).
#pragma once

#include <WebCore/VideoFrame.h>
#include <WebCore/VideoPixelFormat.h>
#include <skia/core/SkRefCnt.h>
#include <wtf/Lock.h>

class SkImage;

namespace BrowserLite {

class VideoFrameWasm final : public WebCore::VideoFrame {
public:
    struct Plane {
        size_t offset { 0 };
        size_t stride { 0 };
        size_t rows { 0 };
    };
    static Vector<Plane> planes(WebCore::VideoPixelFormat, int width, int height);
    static size_t byteSize(WebCore::VideoPixelFormat, int width, int height);

    // Uebernimmt data (mit malloc geholt, wird mit free freigegeben)
    static RefPtr<VideoFrameWasm> adopt(WebCore::VideoPixelFormat, int width, int height, uint8_t* data, size_t size, MediaTime, WebCore::PlatformVideoColorSpace&&);
    // Kopiert RGBA-Pixel (nicht vormultipliziert) mit beliebigem Zeilenabstand
    static RefPtr<VideoFrameWasm> createRGBA(const uint8_t* pixels, size_t stride, int width, int height, bool opaque, MediaTime);

    WebCore::VideoPixelFormat format() const { return m_format; }
    std::span<const uint8_t> data() const;

    WebCore::IntSize presentationSize() const final { return { m_width, m_height }; }
    uint32_t pixelFormat() const final { return static_cast<uint32_t>(m_format) + 1; }

    // Bild in RGBA (nicht vormultipliziert)
    sk_sp<SkImage> image() const;

private:
    struct Buffer : ThreadSafeRefCounted<Buffer> {
        Buffer(uint8_t* data, size_t size)
            : data(data)
            , size(size)
        {
        }
        ~Buffer();
        uint8_t* data;
        size_t size;
    };

    VideoFrameWasm(WebCore::VideoPixelFormat, int width, int height, Ref<Buffer>&&, MediaTime, WebCore::PlatformVideoColorSpace&&);
    Ref<VideoFrame> clone() final;

    const WebCore::VideoPixelFormat m_format;
    const int m_width;
    const int m_height;
    const Ref<Buffer> m_buffer;
    mutable Lock m_imageLock;
    mutable sk_sp<SkImage> m_image WTF_GUARDED_BY_LOCK(m_imageLock);
};

} // namespace BrowserLite
