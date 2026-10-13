// MediaRecorder: nimmt Bild und Ton eines MediaStream auf (Kamera, Canvas,
// Web Audio) und gibt WebM zurueck wie Chrome. Kodieren und Verpacken macht
// engine/js/mediarecorder-host.js mit den Encodern des Host-Browsers.
//
// Bilder und Ton kommen von beliebigen Threads (Audio-Thread bei Web Audio),
// sie gehen kopiert an den Engine-Thread und von dort an das JS.
#include "config.h"

#include "MediaStreamWasm.h"
#include "VideoFrameWasm.h"
#include <WebCore/ContentType.h>
#include "MediaRecorderPrivate.h"
#include <WebCore/MediaRecorderPrivateOptions.h>
#include <WebCore/MediaStreamPrivate.h>
#include <WebCore/MediaStreamTrackPrivate.h>
#include <WebCore/SharedBuffer.h>
#include <cstdlib>
#include <emscripten/emscripten.h>
#include <wtf/HashMap.h>
#include <wtf/JSONValues.h>
#include <wtf/Lock.h>
#include <wtf/MainThread.h>
#include <wtf/MonotonicTime.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/TZoneMallocInlines.h>
#include <wtf/text/MakeString.h>
#include <wtf/text/StringBuilder.h>

namespace BrowserLite {
using namespace WebCore;

namespace {

EM_JS(char*, blJsRecorderCreate, (int id, const char* config), {
    return blRecorder.create(id, UTF8ToString(config));
});
EM_JS(void, blJsRecorderVideo, (int id, const uint8_t* data, int size, int format, int width, int height, double timestamp), {
    blRecorder.video(id, data, size, format, width, height, timestamp);
});
EM_JS(void, blJsRecorderAudio, (int id, const float* samples, int frames, int channels, double sampleRate, double timestamp), {
    blRecorder.audio(id, samples, frames, channels, sampleRate, timestamp);
});
EM_JS(uint8_t*, blJsRecorderTake, (int id, int* length), {
    return blRecorder.take(id, length);
});
EM_JS(void, blJsRecorderFlush, (int id), {
    blRecorder.flush(id);
});
EM_JS(void, blJsRecorderClose, (int id), {
    blRecorder.close(id);
});

// Was der Recorder kann: WebM mit VP8/VP9/AV1 und Opus (wie Chrome)
struct Format {
    bool valid { false };
    bool audioOnly { false };
    String videoCodec;
    bool opus { false };
};

Format parse(const ContentType& type)
{
    Format format;
    auto container = type.containerType().convertToASCIILowercase();
    if (container == "video/webm"_s)
        format.audioOnly = false;
    else if (container == "audio/webm"_s)
        format.audioOnly = true;
    else
        return format;
    for (auto& raw : type.codecs()) {
        auto codec = raw.trim(isASCIIWhitespace<char16_t>).convertToASCIILowercase();
        if (codec == "opus"_s)
            format.opus = true;
        else if (!format.audioOnly && (codec == "vp8"_s || codec == "vp8.0"_s))
            format.videoCodec = "vp8"_s;
        else if (!format.audioOnly && (codec == "vp9"_s || codec == "vp9.0"_s || codec.startsWith("vp09."_s)))
            format.videoCodec = "vp9"_s;
        else if (!format.audioOnly && (codec == "av1"_s || codec.startsWith("av01"_s)))
            format.videoCodec = "av1"_s;
        else
            return format;
    }
    format.valid = true;
    return format;
}

// Gemeinsamer Teil fuer alle Threads: Zeit seit Aufnahmebeginn ohne Pausen
class RecorderClock : public ThreadSafeRefCounted<RecorderClock> {
public:
    double videoTimestamp()
    {
        Locker locker { m_lock };
        return elapsedLocked();
    }
    double audioTimestamp(size_t frames, double sampleRate)
    {
        Locker locker { m_lock };
        if (sampleRate != m_sampleRate || !m_audioStarted) {
            m_audioBase = elapsedLocked();
            m_audioFrames = 0;
            m_sampleRate = sampleRate;
            m_audioStarted = true;
        }
        double timestamp = m_audioBase + m_audioFrames * 1e6 / sampleRate;
        m_audioFrames += frames;
        return timestamp;
    }
    void pause()
    {
        Locker locker { m_lock };
        m_pauseStart = MonotonicTime::now();
    }
    void resume()
    {
        Locker locker { m_lock };
        if (m_pauseStart) {
            m_paused += MonotonicTime::now() - m_pauseStart;
            m_pauseStart = { };
        }
        // Ton nach der Pause wieder an der Uhr ausrichten
        m_audioStarted = false;
    }

private:
    double elapsedLocked() WTF_REQUIRES_LOCK(m_lock)
    {
        auto now = MonotonicTime::now();
        if (!m_start)
            m_start = now;
        return (now - m_start - m_paused).microseconds();
    }

    Lock m_lock;
    MonotonicTime m_start WTF_GUARDED_BY_LOCK(m_lock);
    MonotonicTime m_pauseStart WTF_GUARDED_BY_LOCK(m_lock);
    Seconds m_paused WTF_GUARDED_BY_LOCK(m_lock);
    double m_audioBase WTF_GUARDED_BY_LOCK(m_lock) { 0 };
    uint64_t m_audioFrames WTF_GUARDED_BY_LOCK(m_lock) { 0 };
    double m_sampleRate WTF_GUARDED_BY_LOCK(m_lock) { 0 };
    bool m_audioStarted WTF_GUARDED_BY_LOCK(m_lock) { false };
};

class MediaRecorderPrivateWasm;

HashMap<int, MediaRecorderPrivateWasm*>& recorders()
{
    static NeverDestroyed<HashMap<int, MediaRecorderPrivateWasm*>> map;
    return map;
}

class MediaRecorderPrivateWasm final : public MediaRecorderPrivate {
    WTF_MAKE_TZONE_ALLOCATED_INLINE(MediaRecorderPrivateWasm);
public:
    MediaRecorderPrivateWasm(MediaStreamPrivate& stream, const MediaRecorderPrivateOptions& options, Format&& format)
        : m_id(++s_lastId)
    {
        auto tracks = selectTracks(stream);
        bool hasVideo = tracks.videoTrack && !format.audioOnly;
        bool hasAudio = !!tracks.audioTrack;
        auto bitRates = computeBitRates(options, &stream);

        String videoCodec = format.videoCodec.isNull() ? "vp8"_s : format.videoCodec;
        auto config = JSON::Object::create();
        if (hasVideo) {
            auto video = JSON::Object::create();
            video->setString("codec"_s, videoCodec);
            video->setInteger("bitrate"_s, bitRates.video);
            config->setObject("video"_s, WTF::move(video));
        }
        if (hasAudio) {
            auto audio = JSON::Object::create();
            audio->setInteger("bitrate"_s, bitRates.audio);
            config->setObject("audio"_s, WTF::move(audio));
        }
        m_audioBitRate = hasAudio ? bitRates.audio : 0;
        m_videoBitRate = hasVideo ? bitRates.video : 0;

        // Typ wie Chrome: was die Seite angegeben hat, sonst mit den Codecs
        if (!options.mimeType.isEmpty() && !ContentType(options.mimeType).codecs().isEmpty())
            m_mimeType = options.mimeType;
        else {
            StringBuilder codecs;
            if (hasVideo)
                codecs.append(videoCodec);
            if (hasAudio)
                codecs.append(hasVideo ? ","_s : ""_s, "opus"_s);
            auto container = format.audioOnly || !hasVideo ? "audio/webm"_s : "video/webm"_s;
            m_mimeType = codecs.isEmpty() ? String { container } : makeString(container, ";codecs="_s, codecs.toString());
        }

        if (char* error = blJsRecorderCreate(m_id, config->toJSONString().utf8().data())) {
            m_createError = String::fromUTF8(error);
            std::free(error);
            return;
        }
        recorders().add(m_id, this);
        if (hasVideo)
            setVideoSource(&tracks.videoTrack->source());
        if (hasAudio)
            setAudioSource(&tracks.audioTrack->source());
    }

    ~MediaRecorderPrivateWasm()
    {
        setAudioSource(nullptr);
        setVideoSource(nullptr);
        recorders().remove(m_id);
        blJsRecorderClose(m_id);
        if (auto stop = std::exchange(m_stopCallback, nullptr))
            stop();
        String mimeType = m_mimeType;
        for (auto& callback : std::exchange(m_pendingFetches, { }))
            callback(SharedBuffer::create(), mimeType, 0);
    }

    // Achtung: der letzte Aufruf kann diesen Recorder loeschen (MediaRecorder
    // gibt ihn beim Stoppen an den Rueckruf ab), danach nichts mehr anfassen
    void flushed()
    {
        m_flushing = false;
        if (auto stop = std::exchange(m_stopCallback, nullptr))
            stop();
        auto pending = std::exchange(m_pendingFetches, { });
        if (pending.isEmpty())
            return;
        auto data = take();
        for (size_t index = 0; index < pending.size(); ++index)
            pending[index](index ? Ref<FragmentedSharedBuffer> { SharedBuffer::create() } : data.buffer.copyRef(), data.mimeType, data.timeCode);
    }

private:
    void startRecording(StartRecordingCallback&& callback) final
    {
        if (!m_createError.isNull()) {
            callback(Exception { ExceptionCode::NotSupportedError, m_createError }, 0, 0);
            return;
        }
        callback(String { m_mimeType }, m_audioBitRate, m_videoBitRate);
    }

    void fetchData(FetchDataCallback&& callback) final
    {
        if (m_flushing) {
            m_pendingFetches.append(WTF::move(callback));
            return;
        }
        deliver(WTF::move(callback));
    }

    struct Data {
        Ref<FragmentedSharedBuffer> buffer;
        String mimeType;
        double timeCode;
    };
    Data take()
    {
        int length = 0;
        uint8_t* data = blJsRecorderTake(m_id, &length);
        Data result { SharedBuffer::create(), m_mimeType, m_timeCode };
        if (data && length > 0) {
            result.buffer = SharedBuffer::create(std::span<const uint8_t> { data, static_cast<size_t>(length) });
            m_timeCode = (MonotonicTime::now() - m_startTime).milliseconds();
        }
        std::free(data);
        return result;
    }

    void deliver(FetchDataCallback&& callback)
    {
        auto data = take();
        callback(WTF::move(data.buffer), data.mimeType, data.timeCode);
    }

    String mimeType() const final { return m_mimeType; }

    void stopRecording(CompletionHandler<void()>&& completion) final
    {
        setAudioSource(nullptr);
        setVideoSource(nullptr);
        m_flushing = true;
        m_stopCallback = WTF::move(completion);
        blJsRecorderFlush(m_id);
    }

    void pauseRecording(CompletionHandler<void()>&& completion) final
    {
        m_clock->pause();
        completion();
    }

    void resumeRecording(CompletionHandler<void()>&& completion) final
    {
        m_clock->resume();
        completion();
    }

    void videoFrameAvailable(VideoFrame& frame, VideoFrameTimeMetadata) final
    {
        if (shouldMuteVideo() || !frame.pixelFormat() || frame.pixelFormat() > static_cast<uint32_t>(VideoPixelFormat::BGRX) + 1)
            return;
        double timestamp = m_clock->videoTimestamp();
        auto send = [id = m_id, frame = Ref { frame }, timestamp] {
            auto& wasmFrame = static_cast<VideoFrameWasm&>(frame.get());
            auto data = wasmFrame.data();
            auto size = wasmFrame.presentationSize();
            blJsRecorderVideo(id, data.data(), data.size(), static_cast<int>(wasmFrame.format()), size.width(), size.height(), timestamp);
        };
        if (isMainThread())
            send();
        else
            callOnMainThread(WTF::move(send));
    }

    void audioSamplesAvailable(const MediaTime&, const PlatformAudioData& data, const AudioStreamDescription& description, size_t frames) final
    {
        if (description.platformDescription().type != PlatformDescription::None || data.kind() != PlatformAudioData::Kind::None || !frames)
            return;
        auto& audio = static_cast<const WasmAudioData&>(data);
        unsigned channels = audio.channels();
        double sampleRate = description.sampleRate();
        double timestamp = m_clock->audioTimestamp(frames, sampleRate);
        Vector<float> samples;
        samples.fill(0.0f, channels * frames);
        if (!shouldMuteAudio()) {
            for (unsigned index = 0; index < channels; ++index) {
                auto channel = audio.channel(index);
                for (size_t frame = 0; frame < frames && frame < channel.size(); ++frame)
                    samples[index * frames + frame] = channel[frame];
            }
        }
        auto send = [id = m_id, samples = WTF::move(samples), frames, channels, sampleRate, timestamp] {
            blJsRecorderAudio(id, samples.span().data(), frames, channels, sampleRate, timestamp);
        };
        if (isMainThread())
            send();
        else
            callOnMainThread(WTF::move(send));
    }

    static int s_lastId;
    const int m_id;
    const Ref<RecorderClock> m_clock { adoptRef(*new RecorderClock) };
    String m_mimeType;
    String m_createError;
    unsigned m_audioBitRate { 0 };
    unsigned m_videoBitRate { 0 };
    bool m_flushing { false };
    CompletionHandler<void()> m_stopCallback;
    Vector<FetchDataCallback> m_pendingFetches;
    MonotonicTime m_startTime { MonotonicTime::now() };
    double m_timeCode { 0 };
};

int MediaRecorderPrivateWasm::s_lastId = 0;

} // namespace

} // namespace BrowserLite

namespace WebCore {

bool isMediaRecorderTypeSupportedWasm(const ContentType& type)
{
    return BrowserLite::parse(type).valid;
}

std::unique_ptr<MediaRecorderPrivate> createMediaRecorderPrivateWasm(MediaStreamPrivate& stream, const MediaRecorderPrivateOptions& options)
{
    auto format = options.mimeType.isEmpty() ? BrowserLite::Format { true, false, { }, false } : BrowserLite::parse(ContentType(options.mimeType));
    if (!format.valid)
        return nullptr;
    return makeUnique<BrowserLite::MediaRecorderPrivateWasm>(stream, options, WTF::move(format));
}

} // namespace WebCore

// Aus engine/js/mediarecorder-host.js (Engine-Thread): Encoder sind leer
extern "C" EMSCRIPTEN_KEEPALIVE void bl_recorder_flushed(int id)
{
    if (auto* recorder = BrowserLite::recorders().get(id))
        recorder->flushed();
}
