// Kleine Parser fuer fragmentiertes MP4 und WebM (fuer MSE).
//
// Dekodiert wird im Host-Browser, darum brauchen wir nur Spuren und die Zeit
// jedes Samples (PTS, DTS, Dauer, Keyframe). Damit kennt WebCore `buffered`,
// kann richtig springen und alten Speicher freigeben. Die Daten kommen in
// beliebigen Stuecken (appendBuffer), die Parser merken sich den Rest.
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

    // "video/mp4", "audio/webm", ... -> passender Parser oder nullptr
    static std::unique_ptr<ContainerParser> create(const String& mimeType);
    virtual ~ContainerParser() = default;

    // false: kaputte Daten
    virtual bool append(std::span<const uint8_t>, Client&) = 0;
    // abort(): angefangene Teile wegwerfen
    virtual void reset() = 0;
};

} // namespace BrowserLite
