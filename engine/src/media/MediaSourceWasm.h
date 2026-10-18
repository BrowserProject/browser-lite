// MSE for browser-lite.
//
// WebCore runs the MSE logic (buffered, seeking, memory) with the timestamps
// from our parsers (ContainerParser). The raw data also goes to a MediaSource
// in the host browser, which decodes and plays.
#pragma once

#if ENABLE(MEDIA_SOURCE)

#include "ContainerParser.h"

#include <WebCore/ContentType.h>
#include <WebCore/MediaSourcePrivate.h>
#include <WebCore/SourceBufferPrivate.h>
#include <wtf/WeakPtr.h>

namespace BrowserLite {

class MediaPlayerPrivateWasm;

class MediaSourcePrivateWasm final : public WebCore::MediaSourcePrivate {
public:
    static Ref<MediaSourcePrivateWasm> create(MediaPlayerPrivateWasm&, WebCore::MediaSourcePrivateClient&);
    ~MediaSourcePrivateWasm();

    constexpr WebCore::MediaPlatformType platformType() const final { return WebCore::MediaPlatformType::Wasm; }
    RefPtr<WebCore::MediaPlayerPrivateInterface> player() const final;
    void setPlayer(WebCore::MediaPlayerPrivateInterface*) final;

    void send(ASCIILiteral type, const String& json, std::span<const uint8_t> = { });

private:
    MediaSourcePrivateWasm(MediaPlayerPrivateWasm&, WebCore::MediaSourcePrivateClient&);

    AddStatus addSourceBuffer(const WebCore::ContentType&, const WebCore::MediaSourceConfiguration&, RefPtr<WebCore::SourceBufferPrivate>&) final;
    void removeSourceBuffer(WebCore::SourceBufferPrivate&) final;
    void notifyActiveSourceBuffersChanged() final;
    void durationChanged(const MediaTime&) final;
    void markEndOfStream(EndOfStreamStatus) final;

    WeakPtr<MediaPlayerPrivateWasm> m_player;
    int m_nextSourceBufferId { 1 };
};

class SourceBufferPrivateWasm final : public WebCore::SourceBufferPrivate {
public:
    static Ref<SourceBufferPrivateWasm> create(MediaSourcePrivateWasm&, int id, const WebCore::ContentType&);
    ~SourceBufferPrivateWasm();

    int id() const { return m_id; }

private:
    SourceBufferPrivateWasm(MediaSourcePrivateWasm&, int id, const WebCore::ContentType&);

    constexpr WebCore::MediaPlatformType platformType() const final { return WebCore::MediaPlatformType::Wasm; }
    Ref<WebCore::MediaPromise> appendInternal(Ref<WebCore::SharedBuffer>&&) final;
    void resetParserStateInternal() final;
    void didRemoveCodedFrames(const MediaTime& start, const MediaTime& end) final;
    bool canSwitchToType(const WebCore::ContentType&) final;
    void startChangingType() final;

    RefPtr<MediaSourcePrivateWasm> source() const;
    void didParseInitSegment(ParsedInitSegment&&);

    const int m_id;
    std::unique_ptr<ContainerParser> m_parser;
    String m_pendingType;
};

} // namespace BrowserLite

#endif // ENABLE(MEDIA_SOURCE)
