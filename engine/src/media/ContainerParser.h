// Small parsers for fragmented MP4 and WebM (for MSE).
//
// Decoding happens in the host browser, so we only need the tracks and the
// time of every sample (PTS, DTS, duration, key frame). With that WebCore
// knows `buffered`, can seek correctly and free old memory. The data comes in
// arbitrary pieces (appendBuffer), the parsers remember the rest.
#pragma once

#include <span>
#include <wtf/Function.h>
#include <wtf/MediaTime.h>
#include <wtf/Vector.h>
#include <wtf/text/WTFString.h>

namespace BrowserLite {

struct ParsedTrack {
    uint64_t id { 0 };
    bool isVideo { false };
    bool isAudio { false };
    String codec;
    unsigned width { 0 };
    unsigned height { 0 };
};

struct ParsedInitSegment {
    MediaTime duration { MediaTime::invalidTime() };
    Vector<ParsedTrack> tracks;
};

struct ParsedSample {
    uint64_t trackId { 0 };
    MediaTime presentationTime;
    MediaTime decodeTime;
    MediaTime duration;
    size_t size { 0 };
    bool isSync { true };
};

class ContainerParser {
public:
    struct Client {
        Function<void(ParsedInitSegment&&)> initSegment;
        Function<void(ParsedSample&&)> sample;
    };

    // "video/mp4", "audio/webm", ... -> matching parser or nullptr
    static std::unique_ptr<ContainerParser> create(const String& mimeType);
    virtual ~ContainerParser() = default;

    // false: broken data
    virtual bool append(std::span<const uint8_t>, Client&) = 0;
    // abort(): throw away started parts
    virtual void reset() = 0;
};

} // namespace BrowserLite
