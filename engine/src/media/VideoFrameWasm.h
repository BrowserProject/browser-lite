// VideoFrame for browser-lite (WebCodecs, <video> -> VideoFrame, canvas).
//
// The pixels live in the engine memory, in one block with all planes tightly
// one after another (like VideoFrame.copyTo() returns them without a layout):
// I420 = Y, U, V; NV12 = Y, UV; RGBA etc. = one plane. For drawing we convert
// once to RGBA and keep the image (SkImage, may go to any thread).
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

    // Takes over data (allocated with malloc, freed with free)
    static RefPtr<VideoFrameWasm> adopt(WebCore::VideoPixelFormat, int width, int height, uint8_t* data, size_t size, MediaTime, WebCore::PlatformVideoColorSpace&&);
    // Copies RGBA pixels (not premultiplied) with any row stride
    static RefPtr<VideoFrameWasm> createRGBA(const uint8_t* pixels, size_t stride, int width, int height, bool opaque, MediaTime);

    WebCore::VideoPixelFormat format() const { return m_format; }
    std::span<const uint8_t> data() const;

    WebCore::IntSize presentationSize() const final { return { m_width, m_height }; }
    uint32_t pixelFormat() const final { return static_cast<uint32_t>(m_format) + 1; }

    // Image in RGBA (not premultiplied)
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
