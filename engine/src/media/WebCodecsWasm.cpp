#include "config.h"
#include "WebCodecsWasm.h"

#include "VideoFrameWasm.h"
#include "AudioDecoder.h"
#include "AudioEncoder.h"
#include <WebCore/AudioSampleFormat.h>
#include <WebCore/MediaPlayer.h>
#include <WebCore/PlatformRawAudioData.h>
#include <WebCore/Settings.h>
#include <WebCore/VideoDecoder.h>
#include <WebCore/VideoEncoder.h>
#include "WebCodecsAudioDataAlgorithms.h"
#include <atomic>
#include <cstdlib>
#include <emscripten/emscripten.h>
#include <wtf/Deque.h>
#include <wtf/HashMap.h>
#include <wtf/JSONValues.h>
#include <wtf/MainThread.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/StdLibExtras.h>

// Host side: engine/js/webcodecs-host.js. All calls on the engine thread.
EM_JS(char*, blJsCodecCreate, (int id, int kind, const char* config, const uint8_t* description, int descriptionLength), {
    return blCodecs.create(id, kind, UTF8ToString(config), descriptionLength >= 0 ? HEAPU8.slice(description, description + descriptionLength) : null);
});
EM_JS(char*, blJsCodecDecode, (int id, const uint8_t* data, int length, int key, double timestamp, double duration), {
    return blCodecs.decode(id, HEAPU8.slice(data, data + length), key, timestamp, duration);
});
EM_JS(char*, blJsVideoEncode, (int id, const uint8_t* data, int length, int format, int width, int height, double timestamp, double duration, unsigned colorSpace, int key), {
    return blCodecs.encodeVideo(id, data, length, format, width, height, timestamp, duration, colorSpace, key);
});
EM_JS(char*, blJsAudioEncode, (int id, const uint8_t* data, int length, int format, double sampleRate, int frames, int channels, double timestamp), {
    return blCodecs.encodeAudio(id, data, length, format, sampleRate, frames, channels, timestamp);
});
EM_JS(void, blJsCodecFlush, (int id), {
    blCodecs.flush(id);
});
EM_JS(void, blJsCodecReset, (int id), {
    blCodecs.reset(id);
});
EM_JS(void, blJsCodecClose, (int id), {
    blCodecs.close(id);
});
EM_JS(char*, blJsCodecSetRates, (int id, double bitrate, double framerate), {
    return blCodecs.setRates(id, bitrate, framerate);
});

namespace BrowserLite::WebCodecs {
using namespace WebCore;

namespace {

enum class Kind : int { VideoDecoder = 0, VideoEncoder, AudioDecoder, AudioEncoder };

// What the engine thread knows about a codec. WebCore's codec object can die
// on any thread, the channel only on the engine thread.
struct Channel : ThreadSafeRefCounted<Channel> {
    Channel(int id, Kind kind)
        : id(id)
        , kind(kind)
    {
    }

    const int id;
    const Kind kind;
    bool open { false };
    String error;
    Function<void(String&&)> created;
    VideoDecoder::OutputCallback videoOutput;
    VideoEncoder::OutputCallback videoEncoded;
    VideoEncoder::DescriptionCallback videoDescription;
    AudioDecoder::OutputCallback audioOutput;
    AudioEncoder::OutputCallback audioEncoded;
    AudioEncoder::DescriptionCallback audioDescription;
    Deque<GenericPromise::Producer> flushes;
};

HashMap<int, Ref<Channel>>& channels()
{
    static NeverDestroyed<HashMap<int, Ref<Channel>>> map;
    return map;
}

std::atomic<int> s_nextId { 1 };

String takeString(char* text)
{
    if (!text)
        return { };
    auto result = String::fromUTF8(text);
    std::free(text);
    return result.isNull() ? emptyString() : result;
}

Channel* find(int id)
{
    ASSERT(isMainThread());
    auto it = channels().find(id);
    return it == channels().end() ? nullptr : it->value.ptr();
}

void closeChannel(Ref<Channel>&& channel)
{
    callOnMainThread([channel = WTF::move(channel)] {
        if (channel->open)
            blJsCodecClose(channel->id);
        channel->open = false;
        channel->created = nullptr;
        channel->videoOutput = nullptr;
        channel->videoEncoded = nullptr;
        channel->videoDescription = nullptr;
        channel->audioOutput = nullptr;
        channel->audioEncoded = nullptr;
        channel->audioDescription = nullptr;
        while (!channel->flushes.isEmpty())
            channel->flushes.takeFirst().resolve();
        channels().remove(channel->id);
    });
}

Ref<GenericPromise> flushChannel(const Ref<Channel>& channel)
{
    GenericPromise::Producer producer;
    Ref promise = producer.promise();
    callOnMainThread([channel, producer = WTF::move(producer)]() mutable {
        if (!channel->open) {
            producer.resolve();
            return;
        }
        channel->flushes.append(WTF::move(producer));
        blJsCodecFlush(channel->id);
    });
    return promise;
}

void resetChannel(const Ref<Channel>& channel)
{
    callOnMainThread([channel] {
        if (channel->open)
            blJsCodecReset(channel->id);
    });
}

// Color space as a number: primaries | transfer << 8 | matrix << 16 | range << 24,
// 255 = not set, range 0/1, 2 = not set (order like the IDL)
unsigned packColorSpace(const PlatformVideoColorSpace& colorSpace)
{
    unsigned primaries = colorSpace.primaries ? static_cast<unsigned>(*colorSpace.primaries) : 255;
    unsigned transfer = colorSpace.transfer ? static_cast<unsigned>(*colorSpace.transfer) : 255;
    unsigned matrix = colorSpace.matrix ? static_cast<unsigned>(*colorSpace.matrix) : 255;
    unsigned fullRange = colorSpace.fullRange ? (*colorSpace.fullRange ? 1 : 0) : 2;
    return primaries | transfer << 8 | matrix << 16 | fullRange << 24;
}

PlatformVideoColorSpace unpackColorSpace(unsigned packed)
{
    PlatformVideoColorSpace colorSpace;
    unsigned primaries = packed & 255;
    unsigned transfer = (packed >> 8) & 255;
    unsigned matrix = (packed >> 16) & 255;
    unsigned fullRange = (packed >> 24) & 255;
    if (primaries < static_cast<unsigned>(PlatformVideoColorPrimaries::Unspecified))
        colorSpace.primaries = static_cast<PlatformVideoColorPrimaries>(primaries);
    if (transfer < static_cast<unsigned>(PlatformVideoTransferCharacteristics::Unspecified))
        colorSpace.transfer = static_cast<PlatformVideoTransferCharacteristics>(transfer);
    if (matrix < static_cast<unsigned>(PlatformVideoMatrixCoefficients::Unspecified))
        colorSpace.matrix = static_cast<PlatformVideoMatrixCoefficients>(matrix);
    if (fullRange < 2)
        colorSpace.fullRange = fullRange == 1;
    return colorSpace;
}

std::optional<uint64_t> durationFromHost(double duration)
{
    if (duration < 0)
        return std::nullopt;
    return static_cast<uint64_t>(duration);
}

// Creates a new channel on the engine thread and starts the host codec.
// created() comes later through bl__codec_created.
void startChannel(Kind kind, String&& config, Vector<uint8_t>&& description, bool hasDescription, Function<void(Channel&)>&& setup, Function<void(Ref<Channel>&&, String&&)>&& done)
{
    int id = s_nextId++;
    callOnMainThread([id, kind, config = WTF::move(config).isolatedCopy(), description = WTF::move(description), hasDescription, setup = WTF::move(setup), done = WTF::move(done)]() mutable {
        Ref channel = adoptRef(*new Channel(id, kind));
        setup(channel);
        channel->created = [channel = channel.copyRef(), done = WTF::move(done)](String&& error) mutable {
            done(WTF::move(channel), WTF::move(error));
        };
        channels().add(id, channel.copyRef());
        auto error = takeString(blJsCodecCreate(id, static_cast<int>(kind), config.utf8().data(), description.span().data(), hasDescription ? static_cast<int>(description.size()) : -1));
        if (!error.isNull()) {
            channels().remove(id);
            if (auto created = std::exchange(channel->created, nullptr))
                created(WTF::move(error));
        }
    });
}

class HostVideoDecoder final : public VideoDecoder {
public:
    explicit HostVideoDecoder(Ref<Channel>&& channel)
        : m_channel(WTF::move(channel))
    {
    }
    ~HostVideoDecoder() { closeChannel(m_channel.copyRef()); }

private:
    Ref<DecodePromise> decode(EncodedFrame&& frame) final
    {
        DecodePromise::Producer producer;
        Ref promise = producer.promise();
        callOnMainThread([channel = m_channel, data = Vector<uint8_t> { frame.data }, key = frame.isKeyFrame, timestamp = frame.timestamp, duration = frame.duration, producer = WTF::move(producer)]() mutable {
            if (!channel->open) {
                producer.reject("Decoder is closed"_s);
                return;
            }
            auto error = takeString(blJsCodecDecode(channel->id, data.span().data(), data.size(), key, timestamp, duration ? static_cast<double>(*duration) : -1));
            if (!error.isNull())
                producer.reject(WTF::move(error));
            else
                producer.resolve();
        });
        return promise;
    }
    Ref<GenericPromise> flush() final { return flushChannel(m_channel); }
    void reset() final { resetChannel(m_channel); }
    void close() final { closeChannel(m_channel.copyRef()); }

    const Ref<Channel> m_channel;
};

class HostAudioDecoder final : public AudioDecoder {
public:
    explicit HostAudioDecoder(Ref<Channel>&& channel)
        : m_channel(WTF::move(channel))
    {
    }
    ~HostAudioDecoder() { closeChannel(m_channel.copyRef()); }

private:
    Ref<DecodePromise> decode(EncodedData&& encoded) final
    {
        DecodePromise::Producer producer;
        Ref promise = producer.promise();
        callOnMainThread([channel = m_channel, data = Vector<uint8_t> { encoded.data }, key = encoded.isKeyFrame, timestamp = encoded.timestamp, duration = encoded.duration, producer = WTF::move(producer)]() mutable {
            if (!channel->open) {
                producer.reject("Decoder is closed"_s);
                return;
            }
            auto error = takeString(blJsCodecDecode(channel->id, data.span().data(), data.size(), key, timestamp, duration ? static_cast<double>(*duration) : -1));
            if (!error.isNull())
                producer.reject(WTF::move(error));
            else
                producer.resolve();
        });
        return promise;
    }
    Ref<GenericPromise> flush() final { return flushChannel(m_channel); }
    void reset() final { resetChannel(m_channel); }
    void close() final { closeChannel(m_channel.copyRef()); }

    const Ref<Channel> m_channel;
};

class HostVideoEncoder final : public VideoEncoder {
public:
    explicit HostVideoEncoder(Ref<Channel>&& channel)
        : m_channel(WTF::move(channel))
    {
    }
    ~HostVideoEncoder() { closeChannel(m_channel.copyRef()); }

private:
    Ref<EncodePromise> encode(RawFrame&& raw, bool keyFrame) final
    {
        EncodePromise::Producer producer;
        Ref promise = producer.promise();
        callOnMainThread([channel = m_channel, frame = WTF::move(raw.frame), timestamp = raw.timestamp, duration = raw.duration, keyFrame, producer = WTF::move(producer)]() mutable {
            if (!channel->error.isNull()) {
                producer.reject(String { channel->error });
                return;
            }
            if (!channel->open) {
                producer.reject("Encoder is closed"_s);
                return;
            }
            if (!frame->pixelFormat() || frame->pixelFormat() > static_cast<uint32_t>(VideoPixelFormat::BGRX) + 1) {
                producer.reject("Unsupported video frame"_s);
                return;
            }
            auto& wasmFrame = static_cast<VideoFrameWasm&>(frame.get());
            auto data = wasmFrame.data();
            auto size = wasmFrame.presentationSize();
            auto error = takeString(blJsVideoEncode(channel->id, data.data(), data.size(), static_cast<int>(wasmFrame.format()), size.width(), size.height(), timestamp, duration ? static_cast<double>(*duration) : -1, packColorSpace(wasmFrame.colorSpace()), keyFrame));
            if (!error.isNull())
                producer.reject(WTF::move(error));
            else
                producer.resolve();
        });
        return promise;
    }
    Ref<GenericPromise> setRates(uint64_t bitRate, double frameRate) final
    {
        GenericPromise::Producer producer;
        Ref promise = producer.promise();
        callOnMainThread([channel = m_channel, bitRate, frameRate, producer = WTF::move(producer)]() mutable {
            auto error = channel->open ? takeString(blJsCodecSetRates(channel->id, bitRate, frameRate)) : String { "Encoder is closed"_s };
            if (!error.isNull())
                producer.reject();
            else
                producer.resolve();
        });
        return promise;
    }
    Ref<GenericPromise> flush() final { return flushChannel(m_channel); }
    void reset() final { resetChannel(m_channel); }
    void close() final { closeChannel(m_channel.copyRef()); }

    const Ref<Channel> m_channel;
};

class HostAudioEncoder final : public AudioEncoder {
public:
    explicit HostAudioEncoder(Ref<Channel>&& channel)
        : m_channel(WTF::move(channel))
    {
    }
    ~HostAudioEncoder() { closeChannel(m_channel.copyRef()); }

private:
    Ref<EncodePromise> encode(RawFrame&&) final;
    Ref<GenericPromise> flush() final { return flushChannel(m_channel); }
    void reset() final { resetChannel(m_channel); }
    void close() final { closeChannel(m_channel.copyRef()); }

    const Ref<Channel> m_channel;
};

ASCIILiteral scalabilityMode(VideoEncoderScalabilityMode mode)
{
    switch (mode) {
    case VideoEncoderScalabilityMode::L1T2:
        return "L1T2"_s;
    case VideoEncoderScalabilityMode::L1T3:
        return "L1T3"_s;
    case VideoEncoderScalabilityMode::L1T1:
        break;
    }
    return "L1T1"_s;
}

void createVideoDecoder(const String& codec, const VideoDecoder::Config& config, VideoDecoder::CreateCallback&& callback, VideoDecoder::OutputCallback&& output)
{
    auto object = JSON::Object::create();
    object->setString("codec"_s, codec);
    if (config.width && config.height) {
        object->setInteger("codedWidth"_s, config.width);
        object->setInteger("codedHeight"_s, config.height);
    }
    startChannel(Kind::VideoDecoder, object->toJSONString(), Vector<uint8_t> { config.description }, !config.description.isEmpty(), [output = WTF::move(output)](Channel& channel) mutable {
        channel.videoOutput = WTF::move(output);
    }, [callback = WTF::move(callback)](Ref<Channel>&& channel, String&& error) mutable {
        if (!error.isNull())
            callback(makeUnexpected(WTF::move(error)));
        else
            callback(Ref<VideoDecoder> { adoptRef(*new HostVideoDecoder(WTF::move(channel))) });
    });
}

void createVideoEncoder(const String& codec, const VideoEncoder::Config& config, VideoEncoder::CreateCallback&& callback, VideoEncoder::DescriptionCallback&& description, VideoEncoder::OutputCallback&& output)
{
    auto object = JSON::Object::create();
    object->setString("codec"_s, codec);
    object->setInteger("width"_s, config.width);
    object->setInteger("height"_s, config.height);
    if (config.bitRate)
        object->setDouble("bitrate"_s, config.bitRate);
    if (config.frameRate)
        object->setDouble("framerate"_s, config.frameRate);
    object->setString("latencyMode"_s, config.isRealtime ? "realtime"_s : "quality"_s);
    if (config.scalabilityMode != VideoEncoderScalabilityMode::L1T1)
        object->setString("scalabilityMode"_s, scalabilityMode(config.scalabilityMode));
    object->setBoolean("annexb"_s, config.useAnnexB);
    startChannel(Kind::VideoEncoder, object->toJSONString(), { }, false, [description = WTF::move(description), output = WTF::move(output)](Channel& channel) mutable {
        channel.videoDescription = WTF::move(description);
        channel.videoEncoded = WTF::move(output);
    }, [callback = WTF::move(callback)](Ref<Channel>&& channel, String&& error) mutable {
        if (!error.isNull())
            callback(makeUnexpected(WTF::move(error)));
        else
            callback(Ref<VideoEncoder> { adoptRef(*new HostVideoEncoder(WTF::move(channel))) });
    });
}

} // namespace

// Sound in the engine memory: interleaved in one block or one plane per
// channel one after another
class PlatformRawAudioDataWasm final : public PlatformRawAudioData {
public:
    static Ref<PlatformRawAudioDataWasm> create(Vector<uint8_t>&& data, AudioSampleFormat format, float sampleRate, int64_t timestamp, size_t frames, size_t channels)
    {
        return adoptRef(*new PlatformRawAudioDataWasm(WTF::move(data), format, sampleRate, timestamp, frames, channels));
    }

    constexpr MediaPlatformType platformType() const final { return MediaPlatformType::Wasm; }
    AudioSampleFormat format() const final { return m_format; }
    size_t sampleRate() const final { return m_sampleRate; }
    size_t numberOfChannels() const final { return m_channels; }
    size_t numberOfFrames() const final { return m_frames; }
    std::optional<uint64_t> duration() const final
    {
        if (!m_sampleRate)
            return std::nullopt;
        return static_cast<uint64_t>(m_frames * 1000000.0 / m_sampleRate);
    }
    int64_t timestamp() const final { return m_timestamp; }
    size_t memoryCost() const final { return m_data.size(); }

    float exactSampleRate() const { return m_sampleRate; }
    std::span<const uint8_t> bytes() const { return m_data.span(); }
    bool isInterleaved() const { return isAudioSampleFormatInterleaved(m_format); }

    std::span<uint8_t> plane(size_t index)
    {
        if (isInterleaved())
            return m_data.mutableSpan();
        size_t planeBytes = m_frames * computeBytesPerSample(m_format);
        RELEASE_ASSERT((index + 1) * planeBytes <= m_data.size());
        return m_data.mutableSpan().subspan(index * planeBytes, planeBytes);
    }

    PlaneData planes(size_t samplesOffset)
    {
        size_t count = isInterleaved() ? 1 : m_channels;
        auto subspan = [&](auto span) {
            RELEASE_ASSERT(samplesOffset <= span.size());
            return span.subspan(samplesOffset);
        };
        switch (m_format) {
        case AudioSampleFormat::U8:
        case AudioSampleFormat::U8Planar:
            return Vector<std::span<uint8_t>> { count, [&](size_t index) { return subspan(plane(index)); } };
        case AudioSampleFormat::S16:
        case AudioSampleFormat::S16Planar:
            return Vector<std::span<int16_t>> { count, [&](size_t index) { return subspan(spanReinterpretCast<int16_t>(plane(index))); } };
        case AudioSampleFormat::S32:
        case AudioSampleFormat::S32Planar:
            return Vector<std::span<int32_t>> { count, [&](size_t index) { return subspan(spanReinterpretCast<int32_t>(plane(index))); } };
        case AudioSampleFormat::F32:
        case AudioSampleFormat::F32Planar:
            return Vector<std::span<float>> { count, [&](size_t index) { return subspan(spanReinterpretCast<float>(plane(index))); } };
        }
        RELEASE_ASSERT_NOT_REACHED();
    }

private:
    PlatformRawAudioDataWasm(Vector<uint8_t>&& data, AudioSampleFormat format, float sampleRate, int64_t timestamp, size_t frames, size_t channels)
        : m_data(WTF::move(data))
        , m_format(format)
        , m_sampleRate(sampleRate)
        , m_timestamp(timestamp)
        , m_frames(frames)
        , m_channels(channels)
    {
    }

    Vector<uint8_t> m_data;
    const AudioSampleFormat m_format;
    const float m_sampleRate;
    const int64_t m_timestamp;
    const size_t m_frames;
    const size_t m_channels;
};

namespace {

Ref<AudioEncoder::EncodePromise> HostAudioEncoder::encode(RawFrame&& raw)
{
    EncodePromise::Producer producer;
    Ref promise = producer.promise();
    callOnMainThread([channel = m_channel, frame = WTF::move(raw.frame), timestamp = raw.timestamp, producer = WTF::move(producer)]() mutable {
        if (!channel->error.isNull()) {
            producer.reject(String { channel->error });
            return;
        }
        if (!channel->open || !frame || frame->platformType() != MediaPlatformType::Wasm) {
            producer.reject("Encoder is closed"_s);
            return;
        }
        auto& audio = static_cast<PlatformRawAudioDataWasm&>(*frame);
        auto bytes = audio.bytes();
        auto error = takeString(blJsAudioEncode(channel->id, bytes.data(), bytes.size(), static_cast<int>(audio.format()), audio.exactSampleRate(), audio.numberOfFrames(), audio.numberOfChannels(), timestamp));
        if (!error.isNull())
            producer.reject(WTF::move(error));
        else
            producer.resolve();
    });
    return promise;
}

} // namespace

void initialize()
{
    VideoDecoder::setCreatorCallback(createVideoDecoder);
    VideoEncoder::setCreatorCallback(createVideoEncoder);
}

void enableIn(Settings& settings)
{
    settings.setWebCodecsVideoEnabled(true);
    settings.setWebCodecsAudioEnabled(true);
    settings.setWebCodecsAV1Enabled(true);
    settings.setWebCodecsHEVCEnabled(true);
}

} // namespace BrowserLite::WebCodecs

// Parts of WebCore every platform provides itself (patch 0026)
namespace WebCore {
using BrowserLite::WebCodecs::PlatformRawAudioDataWasm;
using BrowserLite::WebCodecs::Kind;
using BrowserLite::WebCodecs::Channel;

bool AudioDecoder::isCodecSupported(const StringView& codec)
{
    // Whether the host can really do the codec only shows create() (isConfigSupported of the host)
    return codec.startsWith("mp4a.40."_s) || codec == "mp3"_s || codec == "opus"_s || codec == "alaw"_s
        || codec == "ulaw"_s || codec == "flac"_s || codec == "vorbis"_s || codec.startsWith("pcm-"_s);
}

Ref<AudioDecoder::CreatePromise> AudioDecoder::create(const String& codec, const Config& config, OutputCallback&& output)
{
    CreatePromise::Producer producer;
    Ref promise = producer.promise();
    auto object = JSON::Object::create();
    object->setString("codec"_s, codec);
    object->setInteger("sampleRate"_s, config.sampleRate);
    object->setInteger("numberOfChannels"_s, config.numberOfChannels);
    BrowserLite::WebCodecs::startChannel(Kind::AudioDecoder, object->toJSONString(), Vector<uint8_t> { config.description }, !config.description.isEmpty(), [output = WTF::move(output)](Channel& channel) mutable {
        channel.audioOutput = WTF::move(output);
    }, [producer = WTF::move(producer)](Ref<Channel>&& channel, String&& error) mutable {
        if (!error.isNull())
            producer.reject(WTF::move(error));
        else
            producer.resolve(Ref<AudioDecoder> { adoptRef(*new BrowserLite::WebCodecs::HostAudioDecoder(WTF::move(channel))) });
    });
    return promise;
}

Ref<AudioEncoder::CreatePromise> AudioEncoder::create(const String& codec, const Config& config, DescriptionCallback&& description, OutputCallback&& output)
{
    CreatePromise::Producer producer;
    Ref promise = producer.promise();
    auto object = JSON::Object::create();
    object->setString("codec"_s, codec);
    object->setInteger("sampleRate"_s, config.sampleRate);
    object->setInteger("numberOfChannels"_s, config.numberOfChannels);
    if (config.bitRate)
        object->setDouble("bitrate"_s, config.bitRate);
    object->setString("bitrateMode"_s, config.bitRateMode == BitrateMode::Constant ? "constant"_s : "variable"_s);
    if (config.opusConfig) {
        auto opus = JSON::Object::create();
        opus->setString("format"_s, config.opusConfig->isOggBitStream ? "ogg"_s : "opus"_s);
        opus->setDouble("frameDuration"_s, config.opusConfig->frameDuration);
        if (config.opusConfig->complexity)
            opus->setInteger("complexity"_s, *config.opusConfig->complexity);
        opus->setInteger("packetlossperc"_s, config.opusConfig->packetlossperc);
        opus->setBoolean("useinbandfec"_s, config.opusConfig->useinbandfec);
        opus->setBoolean("usedtx"_s, config.opusConfig->usedtx);
        object->setObject("opus"_s, WTF::move(opus));
    }
    if (config.isAacADTS) {
        auto aac = JSON::Object::create();
        aac->setString("format"_s, *config.isAacADTS ? "adts"_s : "aac"_s);
        object->setObject("aac"_s, WTF::move(aac));
    }
    BrowserLite::WebCodecs::startChannel(Kind::AudioEncoder, object->toJSONString(), { }, false, [description = WTF::move(description), output = WTF::move(output)](Channel& channel) mutable {
        channel.audioDescription = WTF::move(description);
        channel.audioEncoded = WTF::move(output);
    }, [producer = WTF::move(producer)](Ref<Channel>&& channel, String&& error) mutable {
        if (!error.isNull())
            producer.reject(WTF::move(error));
        else
            producer.resolve(Ref<AudioEncoder> { adoptRef(*new BrowserLite::WebCodecs::HostAudioEncoder(WTF::move(channel))) });
    });
    return promise;
}

RefPtr<PlatformRawAudioData> PlatformRawAudioData::create(std::span<const uint8_t> data, AudioSampleFormat format, float sampleRate, int64_t timestamp, size_t frames, size_t channels)
{
    size_t needed = frames * channels * computeBytesPerSample(format);
    if (!channels || data.size() < needed)
        return nullptr;
    return PlatformRawAudioDataWasm::create(Vector<uint8_t> { data.first(needed) }, format, sampleRate, timestamp, frames, channels);
}

void PlatformRawAudioData::copyTo(std::span<uint8_t> destination, AudioSampleFormat destinationFormat, size_t planeIndex, std::optional<size_t> frameOffset, std::optional<size_t>, unsigned long copyElementCount)
{
    if (!copyElementCount)
        return;

    // computeCopyElementCount (WebCodecsAudioDataAlgorithms) already checked the values
    auto& audio = static_cast<PlatformRawAudioDataWasm&>(*this);
    auto sourceFormat = format();
    bool destinationIsInterleaved = isAudioSampleFormatInterleaved(destinationFormat);

    if (sourceFormat == destinationFormat || (audioSampleElementFormat(sourceFormat) == audioSampleElementFormat(destinationFormat) && numberOfChannels() == 1)) {
        auto source = audio.plane(audio.isInterleaved() ? 0 : planeIndex);
        size_t frameBytes = computeBytesPerSample(sourceFormat) * (audio.isInterleaved() ? numberOfChannels() : 1);
        size_t offset = frameOffset.value_or(0) * frameBytes;
        size_t length = copyElementCount * computeBytesPerSample(destinationFormat);
        RELEASE_ASSERT(offset + length <= source.size() && length <= destination.size());
        memcpySpan(destination, source.subspan(offset, length));
        return;
    }

    auto source = audio.planes(frameOffset.value_or(0) * (audio.isInterleaved() ? numberOfChannels() : 1));

    if (!audio.isInterleaved() && destinationIsInterleaved) {
        copyToInterleaved(source, destination, destinationFormat, copyElementCount);
        return;
    }

    // interleaved -> planar, planar -> planar, interleaved -> interleaved
    size_t sampleOffset = audio.isInterleaved() ? planeIndex : 0;
    size_t sampleIncrement = audio.isInterleaved() && !destinationIsInterleaved ? numberOfChannels() : 1;
    size_t sourcePlane = audio.isInterleaved() ? 0 : planeIndex;
    auto copyElements = []<typename T>(std::span<T> destination, auto sourcePlane, size_t sampleOffset, size_t sampleIncrement, size_t samples) {
        RELEASE_ASSERT(destination.size() >= samples);
        RELEASE_ASSERT(sourcePlane.size() > sampleOffset + (samples - 1) * sampleIncrement);
        size_t index = sampleOffset;
        for (size_t sample = 0; sample < samples; sample++) {
            destination[sample] = convertAudioSample<T>(sourcePlane[index]);
            index += sampleIncrement;
        }
    };
    WTF::switchOn(audioElementSpan(destinationFormat, destination), [&](auto target) {
        WTF::switchOn(source, [&](auto& planes) {
            copyElements(target, planes[sourcePlane], sampleOffset, sampleIncrement, copyElementCount);
        });
    });
}

} // namespace WebCore

// Messages from the host (engine/js/webcodecs-host.js), engine thread
using BrowserLite::WebCodecs::Kind;

extern "C" {

EMSCRIPTEN_KEEPALIVE void bl__codec_created(int id, char* errorText)
{
    auto error = BrowserLite::WebCodecs::takeString(errorText);
    auto* channel = BrowserLite::WebCodecs::find(id);
    if (!channel)
        return;
    Ref protectedChannel { *channel };
    if (error.isNull())
        channel->open = true;
    else
        BrowserLite::WebCodecs::channels().remove(id);
    if (auto created = std::exchange(channel->created, nullptr))
        created(WTF::move(error));
}

EMSCRIPTEN_KEEPALIVE void bl__codec_error(int id, char* errorText)
{
    auto error = BrowserLite::WebCodecs::takeString(errorText);
    auto* channel = BrowserLite::WebCodecs::find(id);
    if (!channel)
        return;
    channel->error = error;
    if (channel->videoOutput)
        channel->videoOutput(makeUnexpected(WTF::move(error)));
    else if (channel->audioOutput)
        channel->audioOutput(makeUnexpected(WTF::move(error)));
}

EMSCRIPTEN_KEEPALIVE void bl__codec_flushed(int id, int ok)
{
    auto* channel = BrowserLite::WebCodecs::find(id);
    if (!channel || channel->flushes.isEmpty())
        return;
    auto producer = channel->flushes.takeFirst();
    if (ok)
        producer.resolve();
    else
        producer.reject();
}

EMSCRIPTEN_KEEPALIVE void bl__codec_video_frame(int id, uint8_t* data, int size, int format, int width, int height, double timestamp, double duration, unsigned colorSpace)
{
    auto* channel = BrowserLite::WebCodecs::find(id);
    if (!channel || !channel->videoOutput || format < 0 || format > static_cast<int>(WebCore::VideoPixelFormat::BGRX)) {
        std::free(data);
        return;
    }
    auto frame = BrowserLite::VideoFrameWasm::adopt(static_cast<WebCore::VideoPixelFormat>(format), width, height, data, size, MediaTime(static_cast<int64_t>(timestamp), 1000000), BrowserLite::WebCodecs::unpackColorSpace(colorSpace));
    if (!frame)
        return;
    channel->videoOutput(WebCore::VideoDecoder::DecodedFrame { frame.releaseNonNull(), static_cast<int64_t>(timestamp), BrowserLite::WebCodecs::durationFromHost(duration) });
}

EMSCRIPTEN_KEEPALIVE void bl__codec_audio_data(int id, uint8_t* data, int size, int format, double sampleRate, int frames, int channels, double timestamp)
{
    auto* channel = BrowserLite::WebCodecs::find(id);
    if (!channel || !channel->audioOutput || format < 0 || format > static_cast<int>(WebCore::AudioSampleFormat::F32Planar) || channels <= 0 || frames < 0) {
        std::free(data);
        return;
    }
    Vector<uint8_t> bytes { std::span<const uint8_t> { data, static_cast<size_t>(size) } };
    std::free(data);
    auto audioFormat = static_cast<WebCore::AudioSampleFormat>(format);
    if (bytes.size() < static_cast<size_t>(frames) * channels * WebCore::computeBytesPerSample(audioFormat))
        return;
    channel->audioOutput(WebCore::AudioDecoder::DecodedData { BrowserLite::WebCodecs::PlatformRawAudioDataWasm::create(WTF::move(bytes), audioFormat, sampleRate, static_cast<int64_t>(timestamp), frames, channels) });
}

EMSCRIPTEN_KEEPALIVE void bl__codec_encoded(int id, uint8_t* data, int size, int key, double timestamp, double duration, int temporalIndex)
{
    auto* channel = BrowserLite::WebCodecs::find(id);
    Vector<uint8_t> bytes { std::span<const uint8_t> { data, static_cast<size_t>(std::max(size, 0)) } };
    std::free(data);
    if (!channel)
        return;
    if (channel->videoEncoded) {
        std::optional<unsigned> temporal;
        if (temporalIndex >= 0)
            temporal = temporalIndex;
        channel->videoEncoded({ WTF::move(bytes), !!key, static_cast<int64_t>(timestamp), BrowserLite::WebCodecs::durationFromHost(duration), temporal });
    } else if (channel->audioEncoded)
        channel->audioEncoded({ WTF::move(bytes), !!key, static_cast<int64_t>(timestamp), BrowserLite::WebCodecs::durationFromHost(duration) });
}

EMSCRIPTEN_KEEPALIVE void bl__codec_video_config(int id, char* codec, uint8_t* description, int descriptionLength, int displayWidth, int displayHeight, unsigned colorSpace)
{
    auto codecName = BrowserLite::WebCodecs::takeString(codec);
    std::optional<Vector<uint8_t>> bytes;
    if (descriptionLength >= 0)
        bytes = Vector<uint8_t> { std::span<const uint8_t> { description, static_cast<size_t>(descriptionLength) } };
    std::free(description);
    auto* channel = BrowserLite::WebCodecs::find(id);
    if (!channel || !channel->videoDescription)
        return;
    WebCore::VideoEncoder::ActiveConfiguration configuration;
    configuration.codec = codecName;
    if (displayWidth > 0 && displayHeight > 0) {
        configuration.visibleWidth = displayWidth;
        configuration.visibleHeight = displayHeight;
        configuration.displayWidth = displayWidth;
        configuration.displayHeight = displayHeight;
    }
    configuration.description = WTF::move(bytes);
    auto space = BrowserLite::WebCodecs::unpackColorSpace(colorSpace);
    if (space.isValid())
        configuration.colorSpace = space;
    channel->videoDescription(WTF::move(configuration));
}

EMSCRIPTEN_KEEPALIVE void bl__codec_audio_config(int id, char* codec, uint8_t* description, int descriptionLength, int sampleRate, int channels)
{
    auto codecName = BrowserLite::WebCodecs::takeString(codec);
    std::optional<Vector<uint8_t>> bytes;
    if (descriptionLength >= 0)
        bytes = Vector<uint8_t> { std::span<const uint8_t> { description, static_cast<size_t>(descriptionLength) } };
    std::free(description);
    auto* channel = BrowserLite::WebCodecs::find(id);
    if (!channel || !channel->audioDescription)
        return;
    WebCore::AudioEncoder::ActiveConfiguration configuration;
    configuration.codec = codecName;
    if (sampleRate > 0)
        configuration.sampleRate = sampleRate;
    if (channels > 0)
        configuration.numberOfChannels = channels;
    configuration.description = WTF::move(bytes);
    channel->audioDescription(WTF::move(configuration));
}

} // extern "C"
