#include "config.h"
#include "MediaPlayerPrivateWasm.h"

#include "Engine.h"
#include "Host.h"
#include "MediaSourceWasm.h"

#include <WebCore/ContentType.h>
#include <WebCore/GraphicsContext.h>
#include <WebCore/MediaSourcePrivateClient.h>
#include <WebCore/MediaPlayer.h>
#include <WebCore/NativeImage.h>
#include <emscripten/emscripten.h>
#include <skia/core/SkImage.h>
#include <skia/core/SkPixmap.h>
#include <wtf/HashMap.h>
#include <wtf/JSONValues.h>
#include <wtf/Lock.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/RunLoop.h>
#include <wtf/TZoneMallocInlines.h>
#include <wtf/text/MakeString.h>

namespace BrowserLite {

using namespace WebCore;

static HashMap<int, WeakPtr<MediaPlayerPrivateWasm>>& players()
{
    static NeverDestroyed<HashMap<int, WeakPtr<MediaPlayerPrivateWasm>>> map;
    return map;
}

static int nextPlayerId = 1;

MediaPlayerPrivateWasm* MediaPlayerPrivateWasm::fromId(int id)
{
    return players().get(id);
}

// Antworten des Host merken: jede Frage geht synchron ueber den Haupt-Thread und
// wartet, bis die Oberflaeche Zeit hat (auf CNN fragten Werbe-Skripte so oft,
// dass die Engine fast 1 s nur wartete). Die Antworten aendern sich nie.
template<typename Ask>
static int cachedHostAnswer(const String& key, Ask&& ask)
{
    static Lock lock;
    static NeverDestroyed<HashMap<String, int>> answers WTF_GUARDED_BY_LOCK(lock);
    {
        Locker locker { lock };
        auto it = answers->find(key);
        if (it != answers->end())
            return it->value;
    }
    int answer = ask();
    Locker locker { lock };
    answers->set(key.isolatedCopy(), answer);
    return answer;
}

// MSE: kann das MediaSource des Host-Browsers das? (synchron)
static bool hostMediaSourceSupports(const String& type)
{
    return cachedHostAnswer(makeString("mse:"_s, type), [&] {
        auto utf8 = type.utf8();
        return MAIN_THREAD_EM_ASM_INT({
            try {
                return self.MediaSource && MediaSource.isTypeSupported(UTF8ToString($0)) ? 1 : 0;
            } catch (e) {
                return 0;
            }
        }, utf8.data());
    });
}

bool MediaPlayerPrivateWasm::supportsMediaSourceType(const ContentType& type)
{
    auto container = type.containerType().convertToASCIILowercase();
    if (container != "video/mp4"_s && container != "audio/mp4"_s && container != "video/webm"_s && container != "audio/webm"_s)
        return false;
    return hostMediaSourceSupports(type.raw());
}

// Kann der Host-Browser das abspielen? (synchron ueber den Haupt-Thread)
static MediaPlayer::SupportsType hostCanPlayType(const String& type)
{
    int result = cachedHostAnswer(makeString("play:"_s, type), [&] {
        auto utf8 = type.utf8();
        return MAIN_THREAD_EM_ASM_INT({
            try {
                var answer = document.createElement('video').canPlayType(UTF8ToString($0));
                return answer === 'probably' ? 2 : answer === 'maybe' ? 1 : 0;
            } catch (e) {
                return 0;
            }
        }, utf8.data());
    });
    return result == 2 ? MediaPlayer::SupportsType::IsSupported : result == 1 ? MediaPlayer::SupportsType::MayBeSupported : MediaPlayer::SupportsType::IsNotSupported;
}

class MediaPlayerFactoryWasm final : public MediaPlayerFactory {
    WTF_MAKE_TZONE_ALLOCATED_INLINE(MediaPlayerFactoryWasm);
    WTF_OVERRIDE_DELETE_FOR_CHECKED_PTR(MediaPlayerFactoryWasm);
private:
    MediaPlayerEnums::MediaEngineIdentifier identifier() const final { return MediaPlayerEnums::MediaEngineIdentifier::Wasm; }

    Ref<MediaPlayerPrivateInterface> createMediaEnginePlayer(MediaPlayer& player) const final
    {
        return adoptRef(*new MediaPlayerPrivateWasm(player));
    }

    void getSupportedTypes(HashSet<String>& types) const final
    {
        for (auto type : { "video/mp4"_s, "video/webm"_s, "video/ogg"_s, "audio/mp4"_s, "audio/mpeg"_s, "audio/mp3"_s,
            "audio/aac"_s, "audio/ogg"_s, "audio/webm"_s, "audio/wav"_s, "audio/flac"_s, "video/quicktime"_s })
            types.add(type);
    }

    MediaPlayer::SupportsType supportsTypeAndCodecs(const MediaEngineSupportParameters& parameters) const final
    {
        if (parameters.platformType == PlatformMediaDecodingType::MediaSource) {
#if ENABLE(MEDIA_SOURCE)
            return MediaPlayerPrivateWasm::supportsMediaSourceType(parameters.type) ? MediaPlayer::SupportsType::IsSupported : MediaPlayer::SupportsType::IsNotSupported;
#else
            return MediaPlayer::SupportsType::IsNotSupported;
#endif
        }
        if (parameters.platformType != PlatformMediaDecodingType::FileOrHLS)
            return MediaPlayer::SupportsType::IsNotSupported;
        if (parameters.type.isEmpty())
            return MediaPlayer::SupportsType::MayBeSupported;
        return hostCanPlayType(parameters.type.raw());
    }
};

void MediaPlayerPrivateWasm::registerMediaEngine(MediaEngineRegistrar registrar)
{
    registrar(makeUnique<MediaPlayerFactoryWasm>());
}

MediaPlayerPrivateWasm::MediaPlayerPrivateWasm(MediaPlayer& player)
    : m_player(player)
    , m_id(nextPlayerId++)
{
    players().add(m_id, *this);
}

MediaPlayerPrivateWasm::~MediaPlayerPrivateWasm()
{
    players().remove(m_id);
    send("destroy"_s);
}

String MediaPlayerPrivateWasm::referrer() const
{
    if (RefPtr player = m_player.get())
        return player->referrer();
    return { };
}

void MediaPlayerPrivateWasm::send(ASCIILiteral type, const String& json)
{
    notifyMedia(m_id, type, json);
}

void MediaPlayerPrivateWasm::setNetworkState(MediaPlayer::NetworkState state)
{
    if (m_networkState == state)
        return;
    m_networkState = state;
    if (RefPtr player = m_player.get())
        player->networkStateChanged();
}

void MediaPlayerPrivateWasm::load(const String& urlString)
{
    m_url = URL { urlString };
    // Nur was die Engine selber laden kann
    if (!m_url.protocolIsInHTTPFamily()) {
        setNetworkState(MediaPlayer::NetworkState::FormatError);
        return;
    }
    RefPtr player = m_player.get();
    bool muted = player && player->muted();
    double volume = player ? player->volume() : 1;
    send("create"_s, makeString("{\"muted\":"_s, muted ? "true"_s : "false"_s, ",\"volume\":"_s, volume,
        ",\"rate\":"_s, m_rate, ",\"preload\":"_s, player && player->preload() == MediaPlayer::Preload::None ? "\"none\""_s : "\"auto\""_s, '}'));
    setNetworkState(MediaPlayer::NetworkState::Loading);
}

#if ENABLE(MEDIA_SOURCE)
// MSE: das Host-<video> bekommt ein eigenes MediaSource, die Daten kommen
// ueber MediaSourcePrivateWasm/SourceBufferPrivateWasm
void MediaPlayerPrivateWasm::load(const URL& url, const LoadOptions&, MediaSourcePrivateClient& client)
{
    m_url = url;
    m_isMediaSource = true;
    RefPtr player = m_player.get();
    bool muted = player && player->muted();
    double volume = player ? player->volume() : 1;
    // Zuerst den Host-Player anlegen, gleich danach kommen schon die SourceBuffer
    send("create"_s, makeString("{\"mse\":true,\"muted\":"_s, muted ? "true"_s : "false"_s, ",\"volume\":"_s, volume, ",\"rate\":"_s, m_rate, '}'));
    setNetworkState(MediaPlayer::NetworkState::Loading);
    if (RefPtr existing = client.mediaSourcePrivate(); existing && existing->platformType() == MediaPlatformType::Wasm) {
        // Wiederverwenden (z.B. nach einem Wechsel des Players): der Host faengt neu an
        m_mediaSource = static_cast<MediaSourcePrivateWasm*>(existing.get());
        m_mediaSource->setPlayer(this);
        client.reOpen();
    } else
        m_mediaSource = MediaSourcePrivateWasm::create(*this, client);
}

void MediaPlayerPrivateWasm::readyStateFromMediaSourceChanged()
{
    if (RefPtr player = m_player.get())
        player->readyStateChanged();
}

void MediaPlayerPrivateWasm::characteristicsFromMediaSourceChanged()
{
    if (RefPtr player = m_player.get())
        player->characteristicChanged();
}

void MediaPlayerPrivateWasm::mediaSourceHasRetrievedAllData()
{
    setNetworkState(MediaPlayer::NetworkState::Loaded);
}
#endif

void MediaPlayerPrivateWasm::activeSourceBuffersChanged()
{
    if (RefPtr player = m_player.get())
        player->activeSourceBuffersChanged();
}

void MediaPlayerPrivateWasm::mediaSourceDurationChanged()
{
    if (RefPtr player = m_player.get())
        player->durationChanged();
}

bool MediaPlayerPrivateWasm::hasVideo() const
{
#if ENABLE(MEDIA_SOURCE)
    if (m_mediaSource)
        return m_mediaSource->hasVideo();
#endif
    return m_hasVideo;
}

bool MediaPlayerPrivateWasm::hasAudio() const
{
#if ENABLE(MEDIA_SOURCE)
    if (m_mediaSource)
        return m_mediaSource->hasAudio();
#endif
    return m_hasAudio;
}

MediaTime MediaPlayerPrivateWasm::duration() const
{
#if ENABLE(MEDIA_SOURCE)
    if (m_mediaSource)
        return m_mediaSource->duration();
#endif
    return m_duration;
}

MediaPlayer::ReadyState MediaPlayerPrivateWasm::readyState() const
{
#if ENABLE(MEDIA_SOURCE)
    // Was WebCore aus den Daten weiss, aber nicht mehr als der Host schon kann
    if (m_mediaSource)
        return std::min(m_mediaSource->mediaPlayerReadyState(), std::max(m_readyState, MediaPlayer::ReadyState::HaveMetadata));
#endif
    return m_readyState;
}

void MediaPlayerPrivateWasm::cancelLoad()
{
    send("destroy"_s);
}

void MediaPlayerPrivateWasm::play()
{
    m_hostTime = currentTime().toDouble();
    m_hostTimeStamp = MonotonicTime::now();
    m_paused = false;
    m_ended = false;
    send("play"_s);
}

void MediaPlayerPrivateWasm::pause()
{
    m_hostTime = currentTime().toDouble();
    m_hostTimeStamp = MonotonicTime::now();
    m_paused = true;
    send("pause"_s);
}

MediaTime MediaPlayerPrivateWasm::currentTime() const
{
    double time = m_hostTime;
    // Zwischen zwei Meldungen vom Host selber weiterzaehlen
    if (!m_paused && !m_seeking && !m_ended && m_readyState >= MediaPlayer::ReadyState::HaveFutureData)
        time += (MonotonicTime::now() - m_hostTimeStamp).seconds() * m_rate;
    if (m_duration.isValid() && m_duration.isFinite())
        time = std::min(time, m_duration.toDouble());
    return MediaTime::createWithDouble(std::max(0.0, time));
}

Ref<MediaTimePromise> MediaPlayerPrivateWasm::seekToTarget(const SeekTarget& target)
{
    if (auto previous = std::exchange(m_seekPromise, std::nullopt))
        previous->reject(PlatformMediaError::Cancelled);
    m_seeking = true;
    m_ended = false;
    m_hostTime = target.time.toDouble();
    m_hostTimeStamp = MonotonicTime::now();
    m_seekPromise.emplace(PlatformMediaError::Cancelled);
    Ref promise = m_seekPromise->promise();
#if ENABLE(MEDIA_SOURCE)
    if (m_mediaSource) {
        // Erst warten, bis WebCore die Daten fuer die Zielzeit hat
        m_mediaSource->waitForTarget(target)->whenSettled(RunLoop::currentSingleton(), [weakThis = WeakPtr { *this }](auto&& result) {
            RefPtr protectedThis = weakThis.get();
            if (!protectedThis)
                return;
            if (!result) {
                if (auto promise = std::exchange(protectedThis->m_seekPromise, std::nullopt))
                    promise->reject(result.error());
                return;
            }
            protectedThis->m_hostTime = result->toDouble();
            protectedThis->m_mediaSource->reenqueueMediaForTime(*result);
            protectedThis->seekHost(*result);
        });
        return promise;
    }
#endif
    seekHost(target.time);
    return promise;
}

void MediaPlayerPrivateWasm::seekHost(const MediaTime& time)
{
    send("seek"_s, makeString("{\"time\":"_s, time.toDouble(), '}'));
}

void MediaPlayerPrivateWasm::setRate(float rate)
{
    m_hostTime = currentTime().toDouble();
    m_hostTimeStamp = MonotonicTime::now();
    m_rate = rate;
    send("rate"_s, makeString("{\"rate\":"_s, rate, '}'));
}

void MediaPlayerPrivateWasm::setVolume(float volume)
{
    send("volume"_s, makeString("{\"volume\":"_s, volume, '}'));
}

void MediaPlayerPrivateWasm::setMuted(bool muted)
{
    send("muted"_s, makeString("{\"muted\":"_s, muted ? "true"_s : "false"_s, '}'));
}

void MediaPlayerPrivateWasm::setPreservesPitch(bool preservesPitch)
{
    send("pitch"_s, makeString("{\"preservesPitch\":"_s, preservesPitch ? "true"_s : "false"_s, '}'));
}

bool MediaPlayerPrivateWasm::didLoadingProgress() const
{
    auto end = m_buffered.length() ? m_buffered.maximumBufferedTime() : MediaTime::zeroTime();
    bool progressed = end != m_lastBufferedEnd;
    m_lastBufferedEnd = end;
    return progressed;
}

void MediaPlayerPrivateWasm::setPresentationSize(const IntSize& size)
{
    if (size == m_presentationSize)
        return;
    m_presentationSize = size;
    send("size"_s, makeString("{\"width\":"_s, size.width(), ",\"height\":"_s, size.height(), '}'));
}

static RefPtr<NativeImage> imageForFrame(uint8_t* pixels, int width, int height, bool copy)
{
    auto info = SkImageInfo::Make(width, height, kRGBA_8888_SkColorType, kOpaque_SkAlphaType);
    SkPixmap pixmap(info, pixels, static_cast<size_t>(width) * 4);
    auto image = copy ? SkImages::RasterFromPixmapCopy(pixmap) : SkImages::RasterFromPixmap(pixmap, nullptr, nullptr);
    if (!image)
        return nullptr;
    return copy ? NativeImage::create(WTF::move(image)) : NativeImage::createTransient(WTF::move(image));
}

void MediaPlayerPrivateWasm::paint(GraphicsContext& context, const FloatRect& rect)
{
    if (context.paintingDisabled() || !m_frame.pixels)
        return;
    // Ohne Kopie: der Puffer gehoert dem Host und bleibt gueltig, gemalt wird sofort
    if (RefPtr image = imageForFrame(m_frame.pixels, m_frame.width, m_frame.height, false))
        context.drawNativeImage(*image, rect, FloatRect { 0, 0, static_cast<float>(m_frame.width), static_cast<float>(m_frame.height) });
}

RefPtr<NativeImage> MediaPlayerPrivateWasm::nativeImageForCurrentTime()
{
    // Fuer canvas.drawImage(video): eine echte Kopie, die darf laenger leben
    if (!m_frame.pixels)
        return nullptr;
    return imageForFrame(m_frame.pixels, m_frame.width, m_frame.height, true);
}

DestinationColorSpace MediaPlayerPrivateWasm::colorSpace()
{
    return DestinationColorSpace::SRGB();
}

void MediaPlayerPrivateWasm::hostFrame(uint8_t* pixels, int width, int height)
{
    m_frame = { pixels, width, height };
    ++m_presentedFrames;
    m_frameArrival = MonotonicTime::now();
    m_frameMediaTime = currentTime().toDouble();
    if (RefPtr player = m_player.get())
        player->repaint();
}

std::optional<VideoFrameMetadata> MediaPlayerPrivateWasm::videoFrameMetadata()
{
    if (!m_frame.pixels || m_presentedFrames == m_lastMetadataFrame)
        return std::nullopt;
    m_lastMetadataFrame = m_presentedFrames;
    VideoFrameMetadata metadata;
    // Rohe MonotonicTime-Sekunden, HTMLVideoElement rechnet sie in die Zeit der Seite um
    metadata.presentationTime = m_frameArrival.secondsSinceEpoch().seconds();
    metadata.expectedDisplayTime = (m_frameArrival + 16_ms).secondsSinceEpoch().seconds();
    metadata.width = m_frame.width;
    metadata.height = m_frame.height;
    metadata.mediaTime = m_frameMediaTime;
    metadata.presentedFrames = m_presentedFrames;
    return metadata;
}

static MediaPlayer::ReadyState readyStateFromHost(int value)
{
    switch (value) {
    case 1: return MediaPlayer::ReadyState::HaveMetadata;
    case 2: return MediaPlayer::ReadyState::HaveCurrentData;
    case 3: return MediaPlayer::ReadyState::HaveFutureData;
    case 4: return MediaPlayer::ReadyState::HaveEnoughData;
    default: return MediaPlayer::ReadyState::HaveNothing;
    }
}

// Zustand des Host-<video> (web/media.js schickt bei jeder Aenderung alles)
void MediaPlayerPrivateWasm::hostEvent(const String& json)
{
    RefPtr value = JSON::Value::parseJSON(json);
    RefPtr object = value ? value->asObject() : nullptr;
    if (!object)
        return;
    RefPtr player = m_player.get();
    if (!player)
        return;
    Ref protectedThis { *this };
    auto type = object->getString("type"_s);

    if (type == "error"_s) {
        auto code = object->getInteger("code"_s).value_or(4);
        setNetworkState(code == 2 ? MediaPlayer::NetworkState::NetworkError : code == 3 ? MediaPlayer::NetworkState::DecodeError : MediaPlayer::NetworkState::FormatError);
        return;
    }

    auto time = object->getDouble("time"_s).value_or(m_hostTime);
    // Sprung (nicht nur normales Weiterlaufen): WebCore muss es wissen
    bool jumped = std::abs(time - currentTime().toDouble()) > 0.5;
    m_hostTime = time;
    m_hostTimeStamp = MonotonicTime::now();

    if (type == "seeked"_s) {
        m_seeking = false;
        if (auto promise = std::exchange(m_seekPromise, std::nullopt))
            promise->resolve(MediaTime::createWithDouble(time));
        player->timeChanged();
    }

    if (auto duration = object->getDouble("duration"_s); duration && !m_isMediaSource) {
        // -1: unendlich (Live-Stream)
        auto newDuration = *duration < 0 || std::isinf(*duration) ? MediaTime::positiveInfiniteTime() : std::isnan(*duration) ? MediaTime::invalidTime() : MediaTime::createWithDouble(*duration);
        if (newDuration != m_duration) {
            m_duration = newDuration;
            m_seekable = m_duration.isValid() && m_duration.isFinite() ? PlatformTimeRanges { MediaTime::zeroTime(), m_duration } : PlatformTimeRanges { };
            player->durationChanged();
        }
    }

    FloatSize size { static_cast<float>(object->getDouble("width"_s).value_or(0)), static_cast<float>(object->getDouble("height"_s).value_or(0)) };
    bool hasVideo = object->getBoolean("hasVideo"_s).value_or(m_hasVideo);
    bool hasAudio = object->getBoolean("hasAudio"_s).value_or(m_hasAudio);
    if (size != m_naturalSize) {
        m_naturalSize = size;
        player->sizeChanged();
    }
    if (hasVideo != m_hasVideo || hasAudio != m_hasAudio) {
        m_hasVideo = hasVideo;
        m_hasAudio = hasAudio;
        player->characteristicChanged();
    }

    if (RefPtr ranges = object->getArray("buffered"_s)) {
        PlatformTimeRanges buffered;
        for (size_t i = 0; i + 1 < ranges->length(); i += 2) {
            auto start = ranges->get(i)->asDouble().value_or(0);
            auto end = ranges->get(i + 1)->asDouble().value_or(0);
            if (end > start)
                buffered.add(MediaTime::createWithDouble(start), MediaTime::createWithDouble(end));
        }
        m_buffered = WTF::move(buffered);
    }

    // Der Host hat selber pausiert (Ende, Autoplay verboten, ...)
    bool paused = object->getBoolean("paused"_s).value_or(m_paused);
    bool ended = object->getBoolean("ended"_s).value_or(false);
    bool endedNow = ended && !m_ended;
    m_ended = ended;
    if (paused != m_paused) {
        m_paused = paused;
        player->playbackStateChanged();
    }

    auto readyState = readyStateFromHost(object->getInteger("readyState"_s).value_or(0));
    if (readyState != m_readyState) {
        m_readyState = readyState;
        player->readyStateChanged();
    }

    if (m_networkState < MediaPlayer::NetworkState::FormatError && !m_isMediaSource) {
        bool loading = object->getBoolean("loading"_s).value_or(true);
        setNetworkState(m_readyState >= MediaPlayer::ReadyState::HaveEnoughData && !loading ? MediaPlayer::NetworkState::Idle : MediaPlayer::NetworkState::Loading);
    }

    if (endedNow || (jumped && type != "seeked"_s))
        player->timeChanged();
}

} // namespace BrowserLite
