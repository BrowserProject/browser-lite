#pragma once

#include <WebCore/WebSocketDeflater.h>
#include <WebCore/WebSocketExtensionProcessor.h>
#include <WebCore/WebSocketFrame.h>
#include <memory>
#include <optional>
#include <wtf/Vector.h>

namespace BrowserLite {

// The WebSocket compression of Chrome and Firefox (permessage-deflate, RFC 7692) for one
// connection, instead of WebKitLegacy's x-webkit-deflate-frame: its offer in the handshake, then
// whole messages compressed with WebCore's zlib streams once the server accepted it.
class WebSocketPerMessageDeflate {
public:
    // The offer for the handshake; the processor turns the extension on when the server accepts.
    std::unique_ptr<WebCore::WebSocketExtensionProcessor> createExtensionProcessor();

    bool enabled() const { return !!m_deflater; }

    // Compresses an outgoing frame that carries a whole data message: its payload then points
    // into `storage` and RSV1 is set. Control frames, empty messages and connections without
    // the extension stay as they are. False when zlib fails.
    bool compress(WebCore::WebSocketFrame&, Vector<uint8_t>& storage);

    // The data of a received message whose first frame had RSV1 set, all its frames together.
    std::optional<Vector<uint8_t>> decompress(std::span<const uint8_t>);

    // Turns the extension on with the parameters the server accepted.
    bool enable(int clientMaxWindowBits, bool clientNoContextTakeover);

private:
    std::unique_ptr<WebCore::WebSocketDeflater> m_deflater;
    std::unique_ptr<WebCore::WebSocketInflater> m_inflater;
};

} // namespace BrowserLite
