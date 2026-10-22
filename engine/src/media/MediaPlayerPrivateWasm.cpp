#include "config.h"
#include "MediaPlayerPrivateWasm.h"

#include "Engine.h"
#include "EngineConfig.h"
#include "Host.h"
#include "HttpCache.h"
#include "Measurements.h"
#include "MediaSourceWasm.h"
#include "VideoFrameWasm.h"
#if ENABLE(MEDIA_STREAM)
#include "MediaStreamWasm.h"
#endif

#include <WebCore/BlobRegistry.h>
#include <WebCore/BlobRegistryImpl.h>
#include <WebCore/CachedResourceLoader.h>
#include <WebCore/ContentType.h>
#include <WebCore/DataURLDecoder.h>
#include <WebCore/Document.h>
#include <WebCore/GraphicsContext.h>
#include <WebCore/MediaSourcePrivateClient.h>
#include <WebCore/MediaPlayer.h>
#include <WebCore/NativeImage.h>
#include <WebCore/SharedBuffer.h>
#include <cstdlib>
#include <emscripten/emscripten.h>
#include <emscripten/proxying.h>
#include <emscripten/threading.h>
#include <skia/core/SkData.h>
#include <skia/core/SkImage.h>
#include <skia/core/SkPixmap.h>
#include <wtf/HashMap.h>
#include <wtf/JSONValues.h>
#include <wtf/Lock.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/RunLoop.h>
#include <wtf/text/StringToIntegerConversion.h>
#include <wtf/TZoneMallocInlines.h>
#include <wtf/text/MakeString.h>

// Runs on the main thread (prefetchHostAnswers)
EM_JS(void, blJsPrefetchHostAnswers, (), {
    if (typeof document === 'undefined')
        return;
    var play = ['video/mp4', 'video/webm', 'video/ogg', 'video/quicktime', 'video/x-matroska',
        'video/ogg; codecs="theora"', 'video/ogg; codecs="theora, vorbis"',
        'video/mp4; codecs="avc1.42E01E"', 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"',
        'video/mp4; codecs="avc1.4D401E"', 'video/mp4; codecs="avc1.64001E"', 'video/mp4; codecs="hev1"',
        'video/mp4; codecs="hvc1"', 'video/mp4; codecs="av01.0.05M.08"', 'video/mp4; codecs="mp4v.20.8"',
        'video/webm; codecs="vp8, vorbis"', 'video/webm; codecs="vp8"', 'video/webm; codecs="vp9"',
        'video/webm; codecs="vp9, opus"', 'video/webm; codecs="vp09.00.10.08"', 'video/webm; codecs="av01.0.05M.08"',
        'application/vnd.apple.mpegurl', 'application/vnd.apple.mpegURL', 'application/x-mpegURL', 'application/x-mpegurl',
        'audio/mpegurl', 'application/dash+xml', 'audio/mpeg', 'audio/mpeg;', 'audio/mp3', 'audio/mp4', 'audio/mp4; codecs="mp4a.40.2"',
        'audio/aac', 'audio/aac;', 'audio/x-aac', 'audio/x-m4a', 'audio/x-m4a;', 'audio/m4a', 'audio/ogg', 'audio/ogg; codecs="vorbis"',
        'audio/ogg; codecs="opus"', 'audio/ogg; codecs="flac"', 'audio/webm', 'audio/webm; codecs="opus"', 'audio/webm; codecs="vorbis"',
        'audio/wav', 'audio/wav; codecs="1"', 'audio/x-wav', 'audio/flac', 'audio/x-flac', 'audio/opus', 'audio/3gpp', 'video/3gpp'];
    var mse = ['video/mp4; codecs="avc1.42E01E"', 'video/mp4; codecs="avc1.4D401E"', 'video/mp4; codecs="avc1.4d401f"',
        'video/mp4; codecs="avc1.640028"', 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"', 'video/mp4; codecs="av01.0.05M.08"',
        'video/mp4; codecs="hev1.1.6.L93.B0"', 'audio/mp4; codecs="mp4a.40.2"', 'audio/mp4; codecs="mp4a.40.5"',
        'video/webm; codecs="vp8"', 'video/webm; codecs="vp9"', 'video/webm; codecs="vp09.00.10.08"',
        'video/webm; codecs="vp8, vorbis"', 'audio/webm; codecs="opus"', 'audio/webm; codecs="vorbis"',
        'video/mp4', 'video/webm', 'audio/mp4', 'audio/webm'];
    var video = document.createElement('video');
    var lines = [];
    play.forEach(function(type) {
        var answer = video.canPlayType(type);
        lines.push('play:' + type + '\t' + (answer === 'probably' ? 2 : answer === 'maybe' ? 1 : 0));
    });
    mse.forEach(function(type) {
        var supported = self.MediaSource && MediaSource.isTypeSupported(type);
        lines.push('mse:' + type + '\t' + (supported ? 1 : 0));
    });
    var text = stringToNewUTF8(lines.join('\n'));
    Module['_bl__media_host_answers'](text);
    Module['_free'](text);
});

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

static ASCIILiteral preloadName(MediaPlayer::Preload preload)
{
    switch (preload) {
    case MediaPlayer::Preload::None: return "none"_s;
    case MediaPlayer::Preload::MetaData: return "metadata"_s;
    case MediaPlayer::Preload::Auto: return "auto"_s;
    }
    return "auto"_s;
}

// Remembers the host's answers: every question goes synchronously through the
// main thread and waits until the host has time (on CNN ad scripts asked so
// often that the engine waited almost 1 s). The answers never change.
static Lock hostAnswersLock;

static HashMap<String, int>& hostAnswers() WTF_REQUIRES_LOCK(hostAnswersLock)
{
    static NeverDestroyed<HashMap<String, int>> answers;
    return answers;
}

template<typename Ask>
static int cachedHostAnswer(const String& key, Ask&& ask)
{
    {
        Locker locker { hostAnswersLock };
        auto it = hostAnswers().find(key);
        if (it != hostAnswers().end())
            return it->value;
    }
    debugLog("Media: asking the host synchronously (%s)", key.utf8().data());
    int answer = ask();
    Locker locker { hostAnswersLock };
    hostAnswers().set(key.isolatedCopy(), answer);
    return answer;
}

// Has frequent questions answered at start, asynchronously: the first
// synchronous question otherwise waited in the middle of loading until the
// main thread was free (CNN: 0.5 s at canPlayType). Types like in Modernizr
// and common players.
static void prefetchHostAnswers()
{
    emscripten_proxy_async(emscripten_proxy_get_system_queue(), emscripten_main_runtime_thread_id(), [](void*) {
        blJsPrefetchHostAnswers();
    }, nullptr);
}

// MSE: can the MediaSource of the host browser do that? (synchronous)
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

// Can the host browser play that? (synchronous through the main thread)
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

// srcObject = MediaStream: then there is no host <video>
#if ENABLE(MEDIA_STREAM)
#define BL_IF_STREAM(...) if (m_stream) { __VA_ARGS__; }
#else
#define BL_IF_STREAM(...)
#endif

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
        if (!featureEnabled(Feature::Media))
            return;
        for (auto type : { "video/mp4"_s, "video/webm"_s, "video/ogg"_s, "audio/mp4"_s, "audio/mpeg"_s, "audio/mp3"_s,
            "audio/aac"_s, "audio/ogg"_s, "audio/webm"_s, "audio/wav"_s, "audio/flac"_s, "video/quicktime"_s })
            types.add(type);
    }

    MediaPlayer::SupportsType supportsTypeAndCodecs(const MediaEngineSupportParameters& parameters) const final
    {
#if ENABLE(MEDIA_STREAM)
        if (parameters.platformType == PlatformMediaDecodingType::MediaStream)
            return MediaPlayer::SupportsType::IsSupported;
#endif
        // Without the media feature only MediaStream plays (it needs no host <video>)
        if (!featureEnabled(Feature::Media))
            return MediaPlayer::SupportsType::IsNotSupported;
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
        auto answer = hostCanPlayType(parameters.type.raw());
        // Only guessed from the extension (e.g. .mov): the host browser
        // detects the format itself when loading
        if (answer == MediaPlayer::SupportsType::IsNotSupported && parameters.type.typeWasInferredFromExtension())
            return MediaPlayer::SupportsType::MayBeSupported;
        return answer;
    }
};

void MediaPlayerPrivateWasm::registerMediaEngine(MediaEngineRegistrar registrar)
{
    registrar(makeUnique<MediaPlayerFactoryWasm>());
    if (featureEnabled(Feature::Media))
        prefetchHostAnswers();
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
#if ENABLE(MEDIA_STREAM)
    if (m_stream) {
        m_stream->stop();
        return;
    }
#endif
    send("destroy"_s);
}

String MediaPlayerPrivateWasm::referrer() const
{
    if (RefPtr player = m_player.get())
        return player->referrer();
    return { };
}

String MediaPlayerPrivateWasm::httpCachePartition() const
{
    RefPtr player = m_player.get();
    RefPtr loader = player ? player->cachedResourceLoader() : nullptr;
    RefPtr document = loader ? loader->document() : nullptr;
    return document ? HttpCache::partition(*document) : String { };
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
    // A load without a type lands here too (the engine stays registered for MediaStream)
    if (!featureEnabled(Feature::Media)) {
        setNetworkState(MediaPlayer::NetworkState::FormatError);
        return;
    }
    // MediaFetch delivers blob: and data: from these bytes, even after revokeObjectURL
    m_blob = nullptr;
    if (m_url.protocolIsBlob())
        m_blob = blobRegistry()->blobRegistryImpl()->blobDataFromURL(m_url);
    else if (m_url.protocolIsData()) {
        if (auto decoded = DataURLDecoder::decode(m_url, DataURLDecoder::ShouldValidatePadding::No)) {
            m_blob = BlobData::create(decoded->contentType);
            m_blob->appendData(DataSegment::create(WTF::move(decoded->data)));
        }
    }
    if (!m_url.protocolIsInHTTPFamily() && !m_blob) {
        setNetworkState(MediaPlayer::NetworkState::FormatError);
        return;
    }
    RefPtr player = m_player.get();
    bool muted = player && player->muted();
    double volume = player ? player->volume() : 1;
    send("create"_s, makeString("{\"muted\":"_s, muted ? "true"_s : "false"_s, ",\"volume\":"_s, volume,
        ",\"rate\":"_s, m_rate, ",\"preload\":\""_s, preloadName(m_preload), "\",\"hidden\":"_s, m_pageIsVisible ? "false"_s : "true"_s, '}'));
    setNetworkState(MediaPlayer::NetworkState::Loading);
}

void MediaPlayerPrivateWasm::setPreload(MediaPlayer::Preload preload)
{
    if (preload == m_preload)
        return;
    m_preload = preload;
    // Only remember before load(); MSE and MediaStream know no preload
    BL_IF_STREAM(return)
    if (m_url.isEmpty() || m_isMediaSource)
        return;
    send("preload"_s, makeString("{\"preload\":\""_s, preloadName(preload), "\"}"_s));
}

// play() or autoplay: load everything like AVFoundation
void MediaPlayerPrivateWasm::prepareToPlay()
{
    setPreload(MediaPlayer::Preload::Auto);
}

#if ENABLE(MEDIA_SOURCE)
// MSE: the host <video> gets its own MediaSource, the data comes through
// MediaSourcePrivateWasm/SourceBufferPrivateWasm
void MediaPlayerPrivateWasm::load(const URL& url, const LoadOptions&, MediaSourcePrivateClient& client)
{
    m_url = url;
    if (!featureEnabled(Feature::Media)) {
        setNetworkState(MediaPlayer::NetworkState::FormatError);
        return;
    }
    m_isMediaSource = true;
    RefPtr player = m_player.get();
    bool muted = player && player->muted();
    double volume = player ? player->volume() : 1;
    // Create the host player first, the SourceBuffers come right after
    send("create"_s, makeString("{\"mse\":true,\"muted\":"_s, muted ? "true"_s : "false"_s, ",\"volume\":"_s, volume, ",\"rate\":"_s, m_rate,
        ",\"hidden\":"_s, m_pageIsVisible ? "false"_s : "true"_s, '}'));
    setNetworkState(MediaPlayer::NetworkState::Loading);
    if (RefPtr existing = client.mediaSourcePrivate(); existing && existing->platformType() == MediaPlatformType::Wasm) {
        // Reuse (e.g. after a player change): the host starts over
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

#if ENABLE(MEDIA_STREAM)
// srcObject = MediaStream: frames come from WebCore (camera, screen, canvas),
// there is no host <video>
void MediaPlayerPrivateWasm::load(MediaStreamPrivate& stream)
{
    m_stream = MediaStreamPlayback::create(*this, stream);
    m_streamStart = MonotonicTime::now();
    m_duration = MediaTime::positiveInfiniteTime();
    setNetworkState(MediaPlayer::NetworkState::Idle);
    streamChanged();
}
#endif

void MediaPlayerPrivateWasm::streamChanged()
{
#if ENABLE(MEDIA_STREAM)
    if (!m_stream)
        return;
    auto& stream = m_stream->stream();
    m_hasVideo = stream.hasVideo();
    m_hasAudio = stream.hasAudio();
    // Sound only: ready right away, with video only with the first frame
    auto state = !m_hasVideo || m_stream->currentFrame() ? MediaPlayer::ReadyState::HaveEnoughData : MediaPlayer::ReadyState::HaveMetadata;
    RefPtr player = m_player.get();
    if (state != m_readyState) {
        m_readyState = state;
        if (player)
            player->readyStateChanged();
    }
    if (player)
        player->characteristicChanged();
#endif
}

void MediaPlayerPrivateWasm::streamFrameAvailable()
{
#if ENABLE(MEDIA_STREAM)
    if (!m_stream)
        return;
    RefPtr frame = m_stream->currentFrame();
    if (!frame)
        return;
    RefPtr player = m_player.get();
    auto size = frame->presentationSize();
    if (size != m_streamSize) {
        m_streamSize = size;
        m_naturalSize = size;
        if (player)
            player->sizeChanged();
    }
    ++m_presentedFrames;
    m_frameArrival = MonotonicTime::now();
    m_frameMediaTime = currentTime().toDouble();
    if (m_readyState < MediaPlayer::ReadyState::HaveEnoughData)
        streamChanged();
    if (player)
        player->repaint();
#endif
}

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
    // What WebCore knows from the data, but not more than the host can already do
    if (m_mediaSource)
        return std::min(m_mediaSource->mediaPlayerReadyState(), std::max(m_readyState, MediaPlayer::ReadyState::HaveMetadata));
#endif
    return m_readyState;
}

void MediaPlayerPrivateWasm::cancelLoad()
{
    BL_IF_STREAM(return)
    send("destroy"_s);
}

bool MediaPlayerPrivateWasm::hasAvailableVideoFrame() const
{
    BL_IF_STREAM(return !!m_stream->currentFrame())
    return m_frame;
}

void MediaPlayerPrivateWasm::play()
{
    BL_IF_STREAM(m_paused = false; m_stream->setAudioState(true, m_streamVolume, m_streamMuted); return)
    m_hostTime = currentTime().toDouble();
    m_hostTimeStamp = MonotonicTime::now();
    m_paused = false;
    m_ended = false;
    m_loopRestart = false;
    send("play"_s);
}

void MediaPlayerPrivateWasm::pause()
{
    BL_IF_STREAM(m_paused = true; m_stream->setAudioState(false, m_streamVolume, m_streamMuted); return)
    m_hostTime = currentTime().toDouble();
    m_hostTimeStamp = MonotonicTime::now();
    m_paused = true;
    m_loopRestart = false;
    send("pause"_s);
}

MediaTime MediaPlayerPrivateWasm::currentTime() const
{
    BL_IF_STREAM(return MediaTime::createWithDouble((MonotonicTime::now() - m_streamStart).seconds()))
    double time = m_hostTime;
    // Count on ourselves between two messages from the host
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
        // First wait until WebCore has the data for the target time
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
    BL_IF_STREAM(return)
    m_hostTime = currentTime().toDouble();
    m_hostTimeStamp = MonotonicTime::now();
    m_rate = rate;
    send("rate"_s, makeString("{\"rate\":"_s, rate, '}'));
}

void MediaPlayerPrivateWasm::setVolume(float volume)
{
    // Remember also before loading (WebCore sets it when creating the player)
    m_streamVolume = volume;
    BL_IF_STREAM(m_stream->setAudioState(!m_paused, volume, m_streamMuted); return)
    send("volume"_s, makeString("{\"volume\":"_s, volume, '}'));
}

void MediaPlayerPrivateWasm::setMuted(bool muted)
{
    m_streamMuted = muted;
    BL_IF_STREAM(m_stream->setAudioState(!m_paused, m_streamVolume, muted); return)
    send("muted"_s, makeString("{\"muted\":"_s, muted ? "true"_s : "false"_s, '}'));
}

void MediaPlayerPrivateWasm::setPreservesPitch(bool preservesPitch)
{
    BL_IF_STREAM(return)
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
    BL_IF_STREAM(return)
    if (size == m_presentationSize)
        return;
    m_presentationSize = size;
    send("size"_s, makeString("{\"width\":"_s, size.width(), ",\"height\":"_s, size.height(), '}'));
}

// Hidden page: the host sends no frames, the sound keeps playing
void MediaPlayerPrivateWasm::setPageIsVisible(bool visible)
{
    if (visible == m_pageIsVisible)
        return;
    m_pageIsVisible = visible;
    BL_IF_STREAM(return)
    send("visible"_s, visible ? "{\"visible\":true}"_s : "{\"visible\":false}"_s);
}

void MediaPlayerPrivateWasm::paint(GraphicsContext& context, const FloatRect& rect)
{
    auto countFrame = [&] {
        if (std::exchange(m_lastPaintedFrame, m_presentedFrames) != m_presentedFrames)
            Measurements::videoPainted();
    };
#if ENABLE(MEDIA_STREAM)
    if (m_stream) {
        if (RefPtr frame = m_stream->currentFrame(); frame && !context.paintingDisabled()) {
            context.drawVideoFrame(*frame, rect, ImageOrientation::Orientation::None, true);
            countFrame();
        }
        return;
    }
#endif
    if (context.paintingDisabled() || !m_frame)
        return;
    context.drawNativeImage(*m_frame, rect, FloatRect { { }, m_frame->size() });
    countFrame();
}

RefPtr<NativeImage> MediaPlayerPrivateWasm::nativeImageForCurrentTime()
{
#if ENABLE(MEDIA_STREAM)
    if (m_stream) {
        RefPtr frame = m_stream->currentFrame();
        return frame ? frame->copyNativeImage() : nullptr;
    }
#endif
    return m_frame;
}

RefPtr<VideoFrame> MediaPlayerPrivateWasm::videoFrameForCurrentTime()
{
    BL_IF_STREAM(return m_stream->currentFrame())
    SkPixmap pixmap;
    if (!m_frame || !m_frame->platformImage()->peekPixels(&pixmap))
        return nullptr;
    return VideoFrameWasm::createRGBA(pixmap.addr8(), pixmap.rowBytes(), pixmap.width(), pixmap.height(), true, MediaTime::createWithDouble(m_frameMediaTime));
}

DestinationColorSpace MediaPlayerPrivateWasm::colorSpace()
{
    return DestinationColorSpace::SRGB();
}

// The buffer (malloc) belongs to the frame from now on, the host never writes
// into it again. It is freed only when the last recording of the tiles lets go
// of the frame. The host sends the next frame only after "frame": never more
// than one on its way.
void MediaPlayerPrivateWasm::hostFrame(uint8_t* pixels, int width, int height)
{
    size_t rowBytes = static_cast<size_t>(width) * 4;
    auto info = SkImageInfo::Make(width, height, kRGBA_8888_SkColorType, kOpaque_SkAlphaType);
    m_frame = NativeImage::create(SkImages::RasterFromData(info, SkData::MakeFromMalloc(pixels, rowBytes * height), rowBytes));
    send("frame"_s);
    ++m_presentedFrames;
    m_frameArrival = MonotonicTime::now();
    m_frameMediaTime = currentTime().toDouble();
    if (RefPtr player = m_player.get())
        player->repaint();
}

std::optional<VideoFrameMetadata> MediaPlayerPrivateWasm::videoFrameMetadata()
{
    if (!m_frame || m_presentedFrames == m_lastMetadataFrame)
        return std::nullopt;
    m_lastMetadataFrame = m_presentedFrames;
    VideoFrameMetadata metadata;
    // Raw MonotonicTime seconds, HTMLVideoElement converts them to the page's time
    metadata.presentationTime = m_frameArrival.secondsSinceEpoch().seconds();
    metadata.expectedDisplayTime = (m_frameArrival + 16_ms).secondsSinceEpoch().seconds();
    metadata.width = m_frame->size().width();
    metadata.height = m_frame->size().height();
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

// State of the host <video> (the host sends everything on every change)
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
    // Seek (not just normal progress): WebCore has to know
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
        // -1: infinite (live stream)
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

    // The host paused itself (end, autoplay not allowed, ...)
    bool paused = object->getBoolean("paused"_s).value_or(m_paused);
    bool ended = object->getBoolean("ended"_s).value_or(false);
    bool endedNow = ended && !m_ended;
    m_ended = ended;
    // With loop the host <video> (which has no loop itself) pauses at the end, but WebCore only
    // seeks back to the start (timeChanged) and expects the playback to go on, like
    // MediaPlayerPrivateGStreamer::didEnd. Pause reports of the host until it plays again
    // belong to that end.
    if (ended && !m_paused && !m_loopRestart && player->isLooping()) {
        m_loopRestart = true;
        send("play"_s);
    }
    if (m_loopRestart) {
        if (!paused && !ended)
            m_loopRestart = false;
        paused = false;
    }
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

using namespace BrowserLite;

// From the main thread (prefetchHostAnswers): lines "question<TAB>answer"
extern "C" EMSCRIPTEN_KEEPALIVE void bl__media_host_answers(const char* text)
{
    auto lines = String::fromUTF8(text);
    Locker locker { hostAnswersLock };
    for (auto line : StringView(lines).split('\n')) {
        auto tab = line.find('\t');
        if (tab == notFound)
            continue;
        if (auto answer = parseInteger<int>(line.substring(tab + 1)))
            hostAnswers().add(line.left(tab).toString(), *answer);
    }
}
