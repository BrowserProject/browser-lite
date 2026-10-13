#include "config.h"
#include "VideoFrameWasm.h"

#include <WebCore/NativeImage.h>
#include <WebCore/PixelBuffer.h>
#include <cstdlib>
#include <cstring>
#include <skia/core/SkData.h>
#include <skia/core/SkImage.h>
#include <skia/core/SkPixmap.h>

namespace BrowserLite {
using namespace WebCore;

VideoFrameWasm::Buffer::~Buffer()
{
    std::free(data);
}

Vector<VideoFrameWasm::Plane> VideoFrameWasm::planes(VideoPixelFormat format, int width, int height)
{
    size_t w = std::max(width, 0);
    size_t h = std::max(height, 0);
    size_t chromaWidth = (w + 1) / 2;
    size_t chromaHeight = (h + 1) / 2;
    Vector<Plane> result;
    auto add = [&](size_t stride, size_t rows) {
        size_t offset = result.isEmpty() ? 0 : result.last().offset + result.last().stride * result.last().rows;
        result.append({ offset, stride, rows });
    };
    switch (format) {
    case VideoPixelFormat::I420:
    case VideoPixelFormat::I420A:
        add(w, h);
        add(chromaWidth, chromaHeight);
        add(chromaWidth, chromaHeight);
        if (format == VideoPixelFormat::I420A)
            add(w, h);
        break;
    case VideoPixelFormat::I422:
        add(w, h);
        add(chromaWidth, h);
        add(chromaWidth, h);
        break;
    case VideoPixelFormat::I444:
        add(w, h);
        add(w, h);
        add(w, h);
        break;
    case VideoPixelFormat::NV12:
        add(w, h);
        add(chromaWidth * 2, chromaHeight);
        break;
    case VideoPixelFormat::RGBA:
    case VideoPixelFormat::RGBX:
    case VideoPixelFormat::BGRA:
    case VideoPixelFormat::BGRX:
        add(w * 4, h);
        break;
    }
    return result;
}

size_t VideoFrameWasm::byteSize(VideoPixelFormat format, int width, int height)
{
    auto list = planes(format, width, height);
    return list.isEmpty() ? 0 : list.last().offset + list.last().stride * list.last().rows;
}

VideoFrameWasm::VideoFrameWasm(VideoPixelFormat format, int width, int height, Ref<Buffer>&& buffer, MediaTime presentationTime, PlatformVideoColorSpace&& colorSpace)
    : VideoFrame(presentationTime, false, Rotation::None, WTF::move(colorSpace))
    , m_format(format)
    , m_width(width)
    , m_height(height)
    , m_buffer(WTF::move(buffer))
{
}

RefPtr<VideoFrameWasm> VideoFrameWasm::adopt(VideoPixelFormat format, int width, int height, uint8_t* data, size_t size, MediaTime presentationTime, PlatformVideoColorSpace&& colorSpace)
{
    if (width <= 0 || height <= 0 || !data || size < byteSize(format, width, height)) {
        std::free(data);
        return nullptr;
    }
    return adoptRef(*new VideoFrameWasm(format, width, height, adoptRef(*new Buffer(data, size)), presentationTime, WTF::move(colorSpace)));
}

static uint8_t* allocate(size_t size)
{
    return static_cast<uint8_t*>(std::malloc(std::max<size_t>(size, 1)));
}

RefPtr<VideoFrameWasm> VideoFrameWasm::createRGBA(const uint8_t* pixels, size_t stride, int width, int height, bool opaque, MediaTime presentationTime)
{
    if (width <= 0 || height <= 0)
        return nullptr;
    auto format = opaque ? VideoPixelFormat::RGBX : VideoPixelFormat::RGBA;
    size_t rowBytes = static_cast<size_t>(width) * 4;
    auto* data = allocate(rowBytes * height);
    if (!data)
        return nullptr;
    for (int row = 0; row < height; ++row)
        std::memcpy(data + row * rowBytes, pixels + row * stride, rowBytes);
    return adopt(format, width, height, data, rowBytes * height, presentationTime, { PlatformVideoColorPrimaries::Bt709, PlatformVideoTransferCharacteristics::Iec6196621, PlatformVideoMatrixCoefficients::Rgb, true });
}

std::span<const uint8_t> VideoFrameWasm::data() const
{
    return { m_buffer->data, m_buffer->size };
}

Ref<VideoFrame> VideoFrameWasm::clone()
{
    // Die Pixel aendern sich nie, die Kopie teilt sie
    return adoptRef(*new VideoFrameWasm(m_format, m_width, m_height, m_buffer.copyRef(), presentationTime(), PlatformVideoColorSpace { colorSpace() }));
}

// YUV -> RGB in Festkomma (16.16), Koeffizienten nach Matrix und Wertebereich
namespace {
struct YuvToRgb {
    int y { 0 };
    int yOffset { 0 };
    int crToR { 0 };
    int cbToG { 0 };
    int crToG { 0 };
    int cbToB { 0 };

    explicit YuvToRgb(const PlatformVideoColorSpace& colorSpace)
    {
        double kr = 0.2126;
        double kb = 0.0722;
        if (colorSpace.matrix) {
            switch (*colorSpace.matrix) {
            case PlatformVideoMatrixCoefficients::Bt470bg:
            case PlatformVideoMatrixCoefficients::Smpte170m:
            case PlatformVideoMatrixCoefficients::Fcc:
                kr = 0.299;
                kb = 0.114;
                break;
            case PlatformVideoMatrixCoefficients::Smpte240m:
                kr = 0.212;
                kb = 0.087;
                break;
            case PlatformVideoMatrixCoefficients::Bt2020NonconstantLuminance:
            case PlatformVideoMatrixCoefficients::Bt2020ConstantLuminance:
                kr = 0.2627;
                kb = 0.0593;
                break;
            default:
                break;
            }
        }
        bool fullRange = colorSpace.fullRange.value_or(false);
        double kg = 1 - kr - kb;
        double yScale = fullRange ? 1 : 255.0 / 219;
        double cScale = fullRange ? 1 : 255.0 / 224;
        auto fixed = [](double value) { return static_cast<int>(value * 65536 + 0.5); };
        y = fixed(yScale);
        yOffset = fullRange ? 0 : 16;
        crToR = fixed(2 * (1 - kr) * cScale);
        cbToB = fixed(2 * (1 - kb) * cScale);
        cbToG = fixed(2 * kb * (1 - kb) / kg * cScale);
        crToG = fixed(2 * kr * (1 - kr) / kg * cScale);
    }

    static uint8_t clamp(int value)
    {
        value = (value + 32768) >> 16;
        return value < 0 ? 0 : value > 255 ? 255 : value;
    }

    void convert(uint8_t* out, int luma, int cb, int cr) const
    {
        int scaled = (luma - yOffset) * y;
        cb -= 128;
        cr -= 128;
        out[0] = clamp(scaled + crToR * cr);
        out[1] = clamp(scaled - cbToG * cb - crToG * cr);
        out[2] = clamp(scaled + cbToB * cb);
    }
};
}

sk_sp<SkImage> VideoFrameWasm::image() const
{
    Locker locker { m_imageLock };
    if (m_image)
        return m_image;

    size_t rowBytes = static_cast<size_t>(m_width) * 4;
    size_t size = rowBytes * m_height;
    auto* out = allocate(size);
    if (!out)
        return nullptr;
    const uint8_t* source = m_buffer->data;
    auto list = planes(m_format, m_width, m_height);
    bool hasAlpha = false;

    switch (m_format) {
    case VideoPixelFormat::RGBA:
    case VideoPixelFormat::RGBX:
        std::memcpy(out, source, size);
        hasAlpha = m_format == VideoPixelFormat::RGBA;
        if (!hasAlpha) {
            for (size_t i = 3; i < size; i += 4)
                out[i] = 255;
        }
        break;
    case VideoPixelFormat::BGRA:
    case VideoPixelFormat::BGRX:
        hasAlpha = m_format == VideoPixelFormat::BGRA;
        for (size_t i = 0; i < size; i += 4) {
            out[i] = source[i + 2];
            out[i + 1] = source[i + 1];
            out[i + 2] = source[i];
            out[i + 3] = hasAlpha ? source[i + 3] : 255;
        }
        break;
    case VideoPixelFormat::I420:
    case VideoPixelFormat::I420A:
    case VideoPixelFormat::I422:
    case VideoPixelFormat::I444:
    case VideoPixelFormat::NV12: {
        YuvToRgb matrix(colorSpace());
        bool nv12 = m_format == VideoPixelFormat::NV12;
        int shiftX = m_format == VideoPixelFormat::I444 ? 0 : 1;
        int shiftY = m_format == VideoPixelFormat::I420 || m_format == VideoPixelFormat::I420A || nv12 ? 1 : 0;
        hasAlpha = m_format == VideoPixelFormat::I420A;
        for (int row = 0; row < m_height; ++row) {
            const uint8_t* luma = source + list[0].offset + row * list[0].stride;
            const uint8_t* cbRow = source + list[1].offset + (row >> shiftY) * list[1].stride;
            const uint8_t* crRow = nv12 ? cbRow : source + list[2].offset + (row >> shiftY) * list[2].stride;
            const uint8_t* alpha = hasAlpha ? source + list[3].offset + row * list[3].stride : nullptr;
            uint8_t* target = out + row * rowBytes;
            for (int column = 0; column < m_width; ++column) {
                int chroma = column >> shiftX;
                int cb = nv12 ? cbRow[chroma * 2] : cbRow[chroma];
                int cr = nv12 ? crRow[chroma * 2 + 1] : crRow[chroma];
                matrix.convert(target + column * 4, luma[column], cb, cr);
                target[column * 4 + 3] = alpha ? alpha[column] : 255;
            }
        }
        break;
    }
    }

    auto info = SkImageInfo::Make(m_width, m_height, kRGBA_8888_SkColorType, hasAlpha ? kUnpremul_SkAlphaType : kOpaque_SkAlphaType);
    m_image = SkImages::RasterFromData(info, SkData::MakeFromMalloc(out, size), rowBytes);
    return m_image;
}

} // namespace BrowserLite

// Die Teile von WebCore::VideoFrame, die jede Plattform selber liefert
// (Patch 0026 nimmt die leeren Platzhalter in WebCore heraus)
namespace WebCore {
using BrowserLite::VideoFrameWasm;

static RefPtr<VideoFrame> createFromPlanes(VideoPixelFormat format, std::span<const uint8_t> span, size_t width, size_t height, std::initializer_list<const ComputedPlaneLayout*> layouts, PlatformVideoColorSpace&& colorSpace)
{
    if (!width || !height || width > 16384 || height > 16384)
        return nullptr;
    auto planes = VideoFrameWasm::planes(format, width, height);
    if (planes.size() != layouts.size())
        return nullptr;
    size_t size = VideoFrameWasm::byteSize(format, width, height);
    auto* data = static_cast<uint8_t*>(std::calloc(size, 1));
    if (!data)
        return nullptr;
    size_t index = 0;
    for (auto* layout : layouts) {
        auto& plane = planes[index++];
        size_t rowBytes = std::min(plane.stride, layout->sourceWidthBytes ? layout->sourceWidthBytes : plane.stride);
        size_t rows = std::min(plane.rows, layout->sourceHeight ? layout->sourceHeight : plane.rows);
        for (size_t row = 0; row < rows; ++row) {
            size_t from = layout->destinationOffset + row * layout->destinationStride;
            if (from + rowBytes > span.size())
                break;
            std::memcpy(data + plane.offset + row * plane.stride, span.data() + from, rowBytes);
        }
    }
    return VideoFrameWasm::adopt(format, width, height, data, size, MediaTime::zeroTime(), WTF::move(colorSpace));
}

RefPtr<VideoFrame> VideoFrame::createNV12(std::span<const uint8_t> span, size_t width, size_t height, const ComputedPlaneLayout& planeY, const ComputedPlaneLayout& planeUV, PlatformVideoColorSpace&& colorSpace)
{
    return createFromPlanes(VideoPixelFormat::NV12, span, width, height, { &planeY, &planeUV }, WTF::move(colorSpace));
}

RefPtr<VideoFrame> VideoFrame::createRGBA(std::span<const uint8_t> span, size_t width, size_t height, const ComputedPlaneLayout& plane, PlatformVideoColorSpace&& colorSpace)
{
    return createFromPlanes(VideoPixelFormat::RGBA, span, width, height, { &plane }, WTF::move(colorSpace));
}

RefPtr<VideoFrame> VideoFrame::createBGRA(std::span<const uint8_t> span, size_t width, size_t height, const ComputedPlaneLayout& plane, PlatformVideoColorSpace&& colorSpace)
{
    return createFromPlanes(VideoPixelFormat::BGRA, span, width, height, { &plane }, WTF::move(colorSpace));
}

RefPtr<VideoFrame> VideoFrame::createI420(std::span<const uint8_t> span, size_t width, size_t height, const ComputedPlaneLayout& planeY, const ComputedPlaneLayout& planeU, const ComputedPlaneLayout& planeV, PlatformVideoColorSpace&& colorSpace)
{
    return createFromPlanes(VideoPixelFormat::I420, span, width, height, { &planeY, &planeU, &planeV }, WTF::move(colorSpace));
}

RefPtr<VideoFrame> VideoFrame::createI420A(std::span<const uint8_t> span, size_t width, size_t height, const ComputedPlaneLayout& planeY, const ComputedPlaneLayout& planeU, const ComputedPlaneLayout& planeV, const ComputedPlaneLayout& planeA, PlatformVideoColorSpace&& colorSpace)
{
    return createFromPlanes(VideoPixelFormat::I420A, span, width, height, { &planeY, &planeU, &planeV, &planeA }, WTF::move(colorSpace));
}

RefPtr<VideoFrame> VideoFrame::createFromPixelBuffer(Ref<PixelBuffer>&& pixelBuffer, PlatformVideoColorSpace&& colorSpace)
{
    auto& format = pixelBuffer->format();
    auto size = pixelBuffer->size();
    if (size.isEmpty() || format.alphaFormat != AlphaPremultiplication::Unpremultiplied)
        return nullptr;
    if (format.pixelFormat != PixelFormat::BGRA8 && format.pixelFormat != PixelFormat::RGBA8)
        return nullptr;
    auto bytes = pixelBuffer->bytes();
    size_t needed = VideoFrameWasm::byteSize(VideoPixelFormat::RGBA, size.width(), size.height());
    if (bytes.size() < needed)
        return nullptr;
    auto* data = static_cast<uint8_t*>(std::malloc(needed));
    if (!data)
        return nullptr;
    // Wie Chromium: Bilder aus einem Canvas sind RGBA
    if (format.pixelFormat == PixelFormat::BGRA8) {
        for (size_t i = 0; i < needed; i += 4) {
            data[i] = bytes[i + 2];
            data[i + 1] = bytes[i + 1];
            data[i + 2] = bytes[i];
            data[i + 3] = bytes[i + 3];
        }
    } else
        std::memcpy(data, bytes.data(), needed);
    return VideoFrameWasm::adopt(VideoPixelFormat::RGBA, size.width(), size.height(), data, needed, MediaTime::zeroTime(), WTF::move(colorSpace));
}

RefPtr<VideoFrame> VideoFrame::fromNativeImage(NativeImage& nativeImage)
{
    auto image = nativeImage.platformImage();
    if (!image)
        return nullptr;
    int width = image->width();
    int height = image->height();
    if (width <= 0 || height <= 0)
        return nullptr;
    size_t rowBytes = static_cast<size_t>(width) * 4;
    auto* data = static_cast<uint8_t*>(std::malloc(rowBytes * height));
    if (!data)
        return nullptr;
    auto info = SkImageInfo::Make(width, height, kRGBA_8888_SkColorType, kUnpremul_SkAlphaType);
    if (!image->readPixels(nullptr, info, data, rowBytes, 0, 0)) {
        auto raster = image->makeRasterImage(nullptr);
        if (!raster || !raster->readPixels(nullptr, info, data, rowBytes, 0, 0)) {
            std::free(data);
            return nullptr;
        }
    }
    bool opaque = image->isOpaque();
    return VideoFrameWasm::adopt(opaque ? VideoPixelFormat::RGBX : VideoPixelFormat::RGBA, width, height, data, rowBytes * height, MediaTime::zeroTime(),
        { PlatformVideoColorPrimaries::Bt709, PlatformVideoTransferCharacteristics::Iec6196621, PlatformVideoMatrixCoefficients::Rgb, true });
}

static bool sameLayout(VideoPixelFormat a, VideoPixelFormat b)
{
    auto group = [](VideoPixelFormat format) {
        switch (format) {
        case VideoPixelFormat::RGBA:
        case VideoPixelFormat::RGBX:
            return 100;
        case VideoPixelFormat::BGRA:
        case VideoPixelFormat::BGRX:
            return 101;
        default:
            return static_cast<int>(format);
        }
    };
    return group(a) == group(b);
}

void VideoFrame::copyTo(std::span<uint8_t> destination, VideoPixelFormat format, Vector<ComputedPlaneLayout>&& layouts, CopyCallback&& callback)
{
    auto& frame = static_cast<VideoFrameWasm&>(*this);
    if (!sameLayout(frame.format(), format)) {
        callback({ });
        return;
    }
    auto size = frame.presentationSize();
    auto planes = VideoFrameWasm::planes(frame.format(), size.width(), size.height());
    if (planes.size() != layouts.size()) {
        callback({ });
        return;
    }
    auto source = frame.data();
    Vector<PlaneLayout> result;
    for (size_t index = 0; index < layouts.size(); ++index) {
        auto& layout = layouts[index];
        auto& plane = planes[index];
        for (size_t row = 0; row < layout.sourceHeight; ++row) {
            size_t sourceRow = layout.sourceTop + row;
            size_t to = layout.destinationOffset + row * layout.destinationStride;
            if (to + layout.sourceWidthBytes > destination.size()) {
                callback({ });
                return;
            }
            if (sourceRow >= plane.rows || layout.sourceLeftBytes >= plane.stride) {
                std::memset(destination.data() + to, 0, layout.sourceWidthBytes);
                continue;
            }
            size_t bytes = std::min(layout.sourceWidthBytes, plane.stride - layout.sourceLeftBytes);
            std::memcpy(destination.data() + to, source.data() + plane.offset + sourceRow * plane.stride + layout.sourceLeftBytes, bytes);
            if (bytes < layout.sourceWidthBytes)
                std::memset(destination.data() + to + bytes, 0, layout.sourceWidthBytes - bytes);
        }
        result.append({ layout.destinationOffset, layout.destinationStride });
    }
    callback(WTF::move(result));
}

RefPtr<NativeImage> VideoFrame::copyNativeImage() const
{
    auto image = static_cast<const VideoFrameWasm&>(*this).image();
    if (!image)
        return nullptr;
    return NativeImage::create(WTF::move(image));
}

} // namespace WebCore
