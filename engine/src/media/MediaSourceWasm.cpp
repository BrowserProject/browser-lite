#include "config.h"
#include "MediaSourceWasm.h"

#if ENABLE(MEDIA_SOURCE)

#include "Host.h"
#include "MediaPlayerPrivateWasm.h"

#include <WebCore/AudioTrackPrivate.h>
#include <WebCore/MediaDescription.h>
#include <WebCore/MediaSample.h>
#include <WebCore/MediaSourcePrivateClient.h>
#include <WebCore/SharedBuffer.h>
#include <WebCore/VideoTrackPrivate.h>
#include <wtf/TZoneMallocInlines.h>
#include <wtf/text/MakeString.h>

namespace BrowserLite {

using namespace WebCore;

// ------------------------------------------------------------ Helper classes

namespace {

class SampleWasm final : public MediaSample {
public:
    static Ref<SampleWasm> create(const ParsedSample& sample, FloatSize size) { return adoptRef(*new SampleWasm(sample, size)); }

private:
    SampleWasm(const ParsedSample& sample, FloatSize size)
        : m_sample(sample)
        , m_size(size)
    {
    }

    MediaTime presentationTime() const final { return m_sample.presentationTime; }
    MediaTime decodeTime() const final { return m_sample.decodeTime; }
    MediaTime duration() const final { return m_sample.duration; }
    TrackID trackID() const final { return m_sample.trackId; }
    size_t sizeInBytes() const final { return m_sample.size; }
    FloatSize presentationSize() const final { return m_size; }
    void offsetTimestampsBy(const MediaTime& offset) final
    {
        m_sample.presentationTime += offset;
        m_sample.decodeTime += offset;
    }
    void setTimestamps(const MediaTime& presentationTime, const MediaTime& decodeTime) final
    {
        m_sample.presentationTime = presentationTime;
        m_sample.decodeTime = decodeTime;
    }
    Ref<MediaSample> createNonDisplayingCopy() const final
    {
        auto copy = create(m_sample, m_size);
        copy->m_nonDisplaying = true;
        return copy;
    }
    Ref<MediaSample> createCopyWithAdjustedStartTime(const MediaTime& offset) const final
    {
        auto clamped = std::max(MediaTime::zeroTime(), std::min(offset, m_sample.duration));
        auto copy = create(m_sample, m_size);
        copy->m_sample.presentationTime += clamped;
        copy->m_sample.decodeTime += clamped;
        copy->m_sample.duration -= clamped;
        return copy;
    }
    SampleFlags flags() const final
    {
        unsigned flags = None;
        if (m_sample.isSync)
            flags |= IsSync;
        if (m_nonDisplaying)
            flags |= IsNonDisplaying;
        return SampleFlags(flags);
    }
    PlatformSample platformSample() const final { return PlatformSample { static_cast<const MockSampleBox*>(nullptr) }; }
    Type type() const final { return Type::None; }
    void dump(PrintStream&) const final { }

    ParsedSample m_sample;
    FloatSize m_size;
    bool m_nonDisplaying { false };
};

class DescriptionWasm final : public MediaDescription {
public:
    static Ref<DescriptionWasm> create(const ParsedTrack& track) { return adoptRef(*new DescriptionWasm(track)); }
    bool isVideo() const final { return m_video; }
    bool isAudio() const final { return m_audio; }
    bool isText() const final { return false; }

private:
    explicit DescriptionWasm(const ParsedTrack& track)
        : MediaDescription(String { track.codec })
        , m_video(track.isVideo)
        , m_audio(track.isAudio)
    {
    }
    bool m_video;
    bool m_audio;
};

class VideoTrackWasm final : public VideoTrackPrivate {
    WTF_MAKE_TZONE_ALLOCATED_INLINE(VideoTrackWasm);
public:
    static Ref<VideoTrackWasm> create(TrackID id) { return adoptRef(*new VideoTrackWasm(id)); }
    TrackID id() const final { return m_id; }

private:
    explicit VideoTrackWasm(TrackID id)
        : m_id(id)
    {
    }
    TrackID m_id;
};

class AudioTrackWasm final : public AudioTrackPrivate {
    WTF_MAKE_TZONE_ALLOCATED_INLINE(AudioTrackWasm);
public:
    static Ref<AudioTrackWasm> create(TrackID id) { return adoptRef(*new AudioTrackWasm(id)); }
    TrackID id() const final { return m_id; }

private:
    explicit AudioTrackWasm(TrackID id)
        : m_id(id)
    {
    }
    TrackID m_id;
};

// "video/webm; codecs=..." -> "video/webm"
String containerType(const ContentType& type)
{
    return type.containerType().convertToASCIILowercase();
}

String jsonString(const String& value)
{
    return makeString('"', jsonEscape(value), '"');
}

String jsonTime(const MediaTime& time)
{
    if (time.isPositiveInfinite())
        return "-1"_s;
    if (!time.isValid() || time.isNegativeInfinite())
        return "0"_s;
    return String::number(time.toDouble());
}

} // namespace

// ----------------------------------------------------------- MediaSource

Ref<MediaSourcePrivateWasm> MediaSourcePrivateWasm::create(MediaPlayerPrivateWasm& player, MediaSourcePrivateClient& client)
{
    Ref source = adoptRef(*new MediaSourcePrivateWasm(player, client));
    client.setPrivateAndOpen(source.copyRef());
    return source;
}

MediaSourcePrivateWasm::MediaSourcePrivateWasm(MediaPlayerPrivateWasm& player, MediaSourcePrivateClient& client)
    : MediaSourcePrivate(client)
    , m_player(player)
{
}

MediaSourcePrivateWasm::~MediaSourcePrivateWasm() = default;

RefPtr<MediaPlayerPrivateInterface> MediaSourcePrivateWasm::player() const
{
    return m_player.get();
}

void MediaSourcePrivateWasm::setPlayer(MediaPlayerPrivateInterface* player)
{
    m_player = static_cast<MediaPlayerPrivateWasm*>(player);
}

void MediaSourcePrivateWasm::send(ASCIILiteral type, const String& json, std::span<const uint8_t> data)
{
    if (RefPtr player = m_player.get())
        notifyMedia(player->id(), type, json, data);
}

MediaSourcePrivate::AddStatus MediaSourcePrivateWasm::addSourceBuffer(const ContentType& type, const MediaSourceConfiguration&, RefPtr<SourceBufferPrivate>& result)
{
    if (!MediaPlayerPrivateWasm::supportsMediaSourceType(type))
        return AddStatus::NotSupported;
    int id = m_nextSourceBufferId++;
    Ref buffer = SourceBufferPrivateWasm::create(*this, id, type);
    {
        Locker locker { m_lock };
        m_sourceBuffers.append(buffer.ptr());
    }
    buffer->setMediaSourceDuration(duration());
    send("sb-add"_s, makeString("{\"sb\":"_s, id, ",\"type\":"_s, jsonString(type.raw()), '}'));
    result = WTF::move(buffer);
    return AddStatus::Ok;
}

void MediaSourcePrivateWasm::removeSourceBuffer(SourceBufferPrivate& buffer)
{
    send("sb-remove-buffer"_s, makeString("{\"sb\":"_s, static_cast<SourceBufferPrivateWasm&>(buffer).id(), '}'));
    MediaSourcePrivate::removeSourceBuffer(buffer);
}

void MediaSourcePrivateWasm::notifyActiveSourceBuffersChanged()
{
    if (RefPtr player = m_player.get())
        player->activeSourceBuffersChanged();
}

void MediaSourcePrivateWasm::durationChanged(const MediaTime& duration)
{
    MediaSourcePrivate::durationChanged(duration);
    send("ms-duration"_s, makeString("{\"duration\":"_s, jsonTime(duration), '}'));
    if (RefPtr player = m_player.get())
        player->mediaSourceDurationChanged();
}

void MediaSourcePrivateWasm::markEndOfStream(EndOfStreamStatus status)
{
    MediaSourcePrivate::markEndOfStream(status);
    auto name = status == EndOfStreamStatus::NetworkError ? "network"_s : status == EndOfStreamStatus::DecodeError ? "decode"_s : ""_s;
    send("ms-eos"_s, makeString("{\"error\":\""_s, name, "\"}"_s));
}

// ----------------------------------------------------------- SourceBuffer

Ref<SourceBufferPrivateWasm> SourceBufferPrivateWasm::create(MediaSourcePrivateWasm& source, int id, const ContentType& type)
{
    return adoptRef(*new SourceBufferPrivateWasm(source, id, type));
}

SourceBufferPrivateWasm::SourceBufferPrivateWasm(MediaSourcePrivateWasm& source, int id, const ContentType& type)
    : SourceBufferPrivate(source)
    , m_id(id)
    , m_parser(ContainerParser::create(containerType(type)))
{
}

SourceBufferPrivateWasm::~SourceBufferPrivateWasm() = default;

RefPtr<MediaSourcePrivateWasm> SourceBufferPrivateWasm::source() const
{
    return static_cast<MediaSourcePrivateWasm*>(m_mediaSource.get().get());
}

void SourceBufferPrivateWasm::didParseInitSegment(ParsedInitSegment&& parsed)
{
    InitializationSegment segment;
    segment.duration = parsed.duration;
    for (auto& track : parsed.tracks) {
        if (track.isVideo)
            segment.videoTracks.append({ DescriptionWasm::create(track), VideoTrackWasm::create(track.id) });
        else if (track.isAudio)
            segment.audioTracks.append({ DescriptionWasm::create(track), AudioTrackWasm::create(track.id) });
    }
    didReceiveInitializationSegment(WTF::move(segment));
}

Ref<MediaPromise> SourceBufferPrivateWasm::appendInternal(Ref<SharedBuffer>&& data)
{
    RefPtr source = this->source();
    if (!m_parser || !source)
        return MediaPromise::createAndReject(PlatformMediaError::ParsingError);

    // The same data to the MediaSource in the host browser (with timestampOffset and window)
    auto [windowStart, windowEnd] = appendWindow();
    auto contiguous = data->makeContiguous();
    source->send("sb-append"_s, makeString("{\"sb\":"_s, m_id, ",\"offset\":"_s, jsonTime(timestampOffset()),
        ",\"windowStart\":"_s, jsonTime(windowStart), ",\"windowEnd\":"_s, jsonTime(windowEnd), '}'), contiguous->span());

    ContainerParser::Client client {
        [this](ParsedInitSegment&& segment) { didParseInitSegment(WTF::move(segment)); },
        [this](ParsedSample&& sample) { didReceiveSample(SampleWasm::create(sample, { })); },
    };
    if (!m_parser->append(contiguous->span(), client))
        return MediaPromise::createAndReject(PlatformMediaError::ParsingError);
    return MediaPromise::createAndResolve();
}

void SourceBufferPrivateWasm::resetParserStateInternal()
{
    if (m_parser)
        m_parser->reset();
    if (RefPtr source = this->source())
        source->send("sb-abort"_s, makeString("{\"sb\":"_s, m_id, '}'));
}

// remove() of the page and the cleanup before an append: the host has to throw
// away the same frames, otherwise it plays data that no longer exists in WebCore
void SourceBufferPrivateWasm::didRemoveCodedFrames(const MediaTime& start, const MediaTime& end)
{
    if (RefPtr source = this->source())
        source->send("sb-remove"_s, makeString("{\"sb\":"_s, m_id, ",\"start\":"_s, jsonTime(start), ",\"end\":"_s, jsonTime(end), '}'));
}

bool SourceBufferPrivateWasm::canSwitchToType(const ContentType& type)
{
    if (!MediaPlayerPrivateWasm::supportsMediaSourceType(type))
        return false;
    m_pendingType = type.raw();
    return true;
}

void SourceBufferPrivateWasm::startChangingType()
{
    SourceBufferPrivate::startChangingType();
    if (m_pendingType.isEmpty())
        return;
    m_parser = ContainerParser::create(containerType(ContentType { m_pendingType }));
    if (RefPtr source = this->source())
        source->send("sb-type"_s, makeString("{\"sb\":"_s, m_id, ",\"type\":"_s, jsonString(m_pendingType), '}'));
}

} // namespace BrowserLite

#endif // ENABLE(MEDIA_SOURCE)
