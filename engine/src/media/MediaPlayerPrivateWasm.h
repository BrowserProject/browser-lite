// <video>/<audio> fuer browser-lite.
//
// Abgespielt wird in einem versteckten <video> des Host-Browsers (der kann
// alle seine Formate). Die Daten holt der Host ueber einen Service Worker
// (web/sw.js) bei der Engine, die sie mit curl ueber das Relay laedt
// (Range-Requests, Stueck fuer Stueck). Die Bilder kopiert der Host in den
// WASM-Speicher, die Engine malt sie an der richtigen Stelle der Seite.
// Der Ton kommt direkt aus dem Host-<video>.
#pragma once

#include <WebCore/MediaPlayerPrivate.h>
#include <WebCore/PlatformTimeRanges.h>
#include <WebCore/VideoFrameMetadata.h>
#include <wtf/MonotonicTime.h>
#include <wtf/RefCounted.h>
#include <wtf/WeakPtr.h>

namespace WebCore {
class ContentType;
}

namespace BrowserLite {

class MediaSourcePrivateWasm;
class MediaStreamPlayback;

class MediaPlayerPrivateWasm final
    : public WebCore::MediaPlayerPrivateInterface
    , public CanMakeWeakPtr<MediaPlayerPrivateWasm>
    , public RefCounted<MediaPlayerPrivateWasm> {
public:
    explicit MediaPlayerPrivateWasm(WebCore::MediaPlayer&);
    ~MediaPlayerPrivateWasm();

    void ref() const final { RefCounted::ref(); }
    void deref() const final { RefCounted::deref(); }

    static void registerMediaEngine(WebCore::MediaEngineRegistrar);
    static MediaPlayerPrivateWasm* fromId(int);
    // MSE: Container, den unsere Parser kennen und den der Host-Browser abspielt
    static bool supportsMediaSourceType(const WebCore::ContentType&);

    // Meldungen vom Host (Exports.cpp)
    void hostEvent(const String& json);
    void hostFrame(uint8_t* pixels, int width, int height);

    int id() const { return m_id; }
    const URL& url() const { return m_url; }
    String referrer() const;

    // Von MediaSourcePrivateWasm
    void activeSourceBuffersChanged();
    void mediaSourceDurationChanged();

    // Von MediaStreamPlayback (srcObject = MediaStream)
    void streamChanged();
    void streamFrameAvailable();

private:
    constexpr WebCore::MediaPlayerType mediaPlayerType() const final { return m_isMediaSource ? WebCore::MediaPlayerType::WasmMSE : WebCore::MediaPlayerType::Wasm; }

    void load(const String&) final;
#if ENABLE(MEDIA_SOURCE)
    void load(const URL&, const LoadOptions&, WebCore::MediaSourcePrivateClient&) final;
    void readyStateFromMediaSourceChanged() final;
    void characteristicsFromMediaSourceChanged() final;
    void mediaSourceHasRetrievedAllData() final;
#endif
#if ENABLE(MEDIA_STREAM)
    void load(WebCore::MediaStreamPrivate&) final;
#endif
    void cancelLoad() final;

    void play() final;
    void pause() final;

    WebCore::FloatSize naturalSize() const final { return m_naturalSize; }
    bool hasVideo() const final;
    bool hasAudio() const final;
    void setPageIsVisible(bool) final { }

    MediaTime duration() const final;
    MediaTime currentTime() const final;
    Ref<WebCore::MediaTimePromise> seekToTarget(const WebCore::SeekTarget&) final;
    bool paused() const final { return m_paused; }

    void setRate(float) final;
    double rate() const final { return m_rate; }
    void setVolume(float) final;
    void setMuted(bool) final;
    void setPreservesPitch(bool) final;

    WebCore::MediaPlayer::NetworkState networkState() const final { return m_networkState; }
    WebCore::MediaPlayer::ReadyState readyState() const final;

    const WebCore::PlatformTimeRanges& seekable() const final { return m_seekable; }
    MediaTime maxTimeSeekable() const final { return m_duration.isFinite() ? m_duration : MediaTime::zeroTime(); }
    const WebCore::PlatformTimeRanges& buffered() const final { return m_buffered; }
    bool didLoadingProgress() const final;

    void setPresentationSize(const WebCore::IntSize&) final;
    void paint(WebCore::GraphicsContext&, const WebCore::FloatRect&) final;
    RefPtr<WebCore::NativeImage> nativeImageForCurrentTime() final;
    // new VideoFrame(video) (WebCodecs)
    RefPtr<WebCore::VideoFrame> videoFrameForCurrentTime() final;
    WebCore::DestinationColorSpace colorSpace() final;
    bool hasAvailableVideoFrame() const final;
    // requestVideoFrameCallback: Angaben zum neusten Bild, nur einmal pro Bild
    std::optional<WebCore::VideoFrameMetadata> videoFrameMetadata() final;

    bool didPassCORSAccessCheck() const final { return true; }

    void send(ASCIILiteral type, const String& json = "{}"_s);
    void seekHost(const MediaTime&);
    void setNetworkState(WebCore::MediaPlayer::NetworkState);

    ThreadSafeWeakPtr<WebCore::MediaPlayer> m_player;
    const int m_id;
    URL m_url;
    bool m_isMediaSource { false };
#if ENABLE(MEDIA_SOURCE)
    RefPtr<MediaSourcePrivateWasm> m_mediaSource;
#endif
#if ENABLE(MEDIA_STREAM)
    RefPtr<MediaStreamPlayback> m_stream;
    WebCore::IntSize m_streamSize;
    MonotonicTime m_streamStart;
#endif

    WebCore::MediaPlayer::NetworkState m_networkState { WebCore::MediaPlayer::NetworkState::Empty };
    WebCore::MediaPlayer::ReadyState m_readyState { WebCore::MediaPlayer::ReadyState::HaveNothing };
    bool m_paused { true };
    bool m_ended { false };
    bool m_hasVideo { false };
    bool m_hasAudio { false };
    double m_rate { 1 };
    MediaTime m_duration { MediaTime::invalidTime() };
    WebCore::FloatSize m_naturalSize;
    WebCore::PlatformTimeRanges m_buffered;
    WebCore::PlatformTimeRanges m_seekable;
    mutable MediaTime m_lastBufferedEnd;

    // Zeit vom Host und wann sie kam (dazwischen rechnen wir selber weiter)
    double m_hostTime { 0 };
    MonotonicTime m_hostTimeStamp;
    bool m_seeking { false };
    std::optional<WebCore::MediaTimePromise::AutoRejectProducer> m_seekPromise;

    struct Frame {
        uint8_t* pixels { nullptr };
        int width { 0 };
        int height { 0 };
    };
    Frame m_frame;
    unsigned m_presentedFrames { 0 };
    unsigned m_lastMetadataFrame { 0 };
    MonotonicTime m_frameArrival;
    double m_frameMediaTime { 0 };
    WebCore::IntSize m_presentationSize;
};

} // namespace BrowserLite
