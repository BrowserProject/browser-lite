#include "config.h"
#include "WebSocketPerMessageDeflate.h"

#include <wtf/ASCIICType.h>
#include <wtf/text/MakeString.h>
#include <wtf/text/StringHash.h>

namespace BrowserLite {

using namespace WebCore;

namespace {

// RFC 7692 7.1.2: a window size is a decimal integer from 8 to 15 without leading zeros.
std::optional<int> windowBits(const String& value)
{
    if (value.isEmpty() || value.length() > 2 || value[0] == '0')
        return std::nullopt;
    int bits = 0;
    for (auto character : StringView(value).codeUnits()) {
        if (!isASCIIDigit(character))
            return std::nullopt;
        bits = bits * 10 + (character - '0');
    }
    if (bits < 8 || bits > 15)
        return std::nullopt;
    return bits;
}

class Negotiation final : public WebSocketExtensionProcessor {
    WTF_DEPRECATED_MAKE_FAST_ALLOCATED(Negotiation);
public:
    explicit Negotiation(WebSocketPerMessageDeflate& extension)
        : WebSocketExtensionProcessor("permessage-deflate"_s)
        , m_extension(extension)
    {
    }

private:
    // Chrome's offer: the server may limit the window of the client.
    String handshakeString() final { return "permessage-deflate; client_max_window_bits"_s; }

    bool processResponse(const HashMap<String, String>& parameters) final
    {
        if (m_answered)
            return reject("Received duplicate permessage-deflate response"_s);
        m_answered = true;

        int clientMaxWindowBits = 15;
        bool clientNoContextTakeover = false;
        for (auto& [name, value] : parameters) {
            if (name == "server_no_context_takeover"_s || name == "client_no_context_takeover"_s) {
                if (!value.isNull())
                    return reject(makeString("Received invalid "_s, name, " parameter"_s));
                clientNoContextTakeover |= name == "client_no_context_takeover"_s;
            } else if (name == "server_max_window_bits"_s || name == "client_max_window_bits"_s) {
                auto bits = windowBits(value);
                if (!bits)
                    return reject(makeString("Received invalid "_s, name, " parameter"_s));
                if (name == "client_max_window_bits"_s)
                    clientMaxWindowBits = *bits;
            } else
                return reject(makeString("Received unexpected permessage-deflate parameter: "_s, name));
        }
        if (!m_extension.enable(clientMaxWindowBits, clientNoContextTakeover))
            return reject("Failed to start permessage-deflate"_s);
        return true;
    }

    String failureReason() final { return m_failureReason; }

    bool reject(String&& reason)
    {
        m_failureReason = WTF::move(reason);
        return false;
    }

    WebSocketPerMessageDeflate& m_extension;
    bool m_answered { false };
    String m_failureReason;
};

} // namespace

std::unique_ptr<WebSocketExtensionProcessor> WebSocketPerMessageDeflate::createExtensionProcessor()
{
    return makeUnique<Negotiation>(*this);
}

bool WebSocketPerMessageDeflate::enable(int clientMaxWindowBits, bool clientNoContextTakeover)
{
    // zlib has no raw deflate with a 256 byte window; its 512 byte window never reaches back
    // further than 250 bytes, so the server's 256 byte window still covers it.
    int deflateWindowBits = std::max(clientMaxWindowBits, 9);
    auto deflater = makeUnique<WebSocketDeflater>(deflateWindowBits, clientNoContextTakeover ? WebSocketDeflater::DoNotTakeOverContext : WebSocketDeflater::TakeOverContext);
    // 15 bits inflate whatever window the server uses.
    auto inflater = makeUnique<WebSocketInflater>(15);
    if (!deflater->initialize() || !inflater->initialize())
        return false;
    m_deflater = WTF::move(deflater);
    m_inflater = WTF::move(inflater);
    return true;
}

bool WebSocketPerMessageDeflate::compress(WebSocketFrame& frame, Vector<uint8_t>& storage)
{
    if (!enabled() || !WebSocketFrame::isNonControlOpCode(frame.opCode) || frame.payload.empty())
        return true;
    bool compressed = m_deflater->addBytes(frame.payload) && m_deflater->finish();
    if (compressed)
        storage = m_deflater->span();
    m_deflater->reset();
    if (!compressed)
        return false;
    frame.compress = true;
    frame.payload = storage.span();
    return true;
}

std::optional<Vector<uint8_t>> WebSocketPerMessageDeflate::decompress(std::span<const uint8_t> data)
{
    ASSERT(enabled());
    // A sender compresses the empty message to one byte; none at all leaves the stream as it is.
    if (data.empty())
        return Vector<uint8_t> { };
    bool inflated = m_inflater->addBytes(data) && m_inflater->finish();
    std::optional<Vector<uint8_t>> message;
    if (inflated)
        message = Vector<uint8_t>(m_inflater->span());
    m_inflater->reset();
    return message;
}

} // namespace BrowserLite
