// CryptoKeys are serializable (WebCrypto, HTML structured clone): WebCore writes them
// through the page's CryptoClient, whose default refuses every key. Like the OpenSSL ports
// (WPE, GTK) and like Chrome and Firefox the serialized key is stored without a wrapping
// master key: it would sit in the same OPFS as the databases it is meant to protect
// (#527). Workers reach this through their loader's document.
#include "config.h"
#include "CryptoKeys.h"

#include <WebCore/CryptoClient.h>
#include <WebCore/CryptoKey.h>
#include <WebCore/CryptoKeyData.h>
#include <WebCore/SerializedCryptoKeyWrap.h>
#include <WebCore/SerializedScriptValue.h>
#include <WebCore/WrappedCryptoKey.h>
#include <wtf/TZoneMallocInlines.h>

using namespace WebCore;

namespace BrowserLite {

class EngineCryptoClient final : public CryptoClient {
    WTF_MAKE_TZONE_ALLOCATED_INLINE(EngineCryptoClient);
public:
    std::optional<Vector<uint8_t>> serializeAndWrapCryptoKey(CryptoKeyData&& data) const final
    {
        RefPtr key = CryptoKey::create(WTF::move(data));
        if (!key || !key->isValid())
            return std::nullopt;
        Vector<uint8_t> wrapped;
        if (!wrapSerializedCryptoKey({ }, SerializedScriptValue::serializeCryptoKey(*key), wrapped))
            return std::nullopt;
        return wrapped;
    }

    std::optional<Vector<uint8_t>> unwrapCryptoKey(const Vector<uint8_t>& wrapped) const final
    {
        auto key = readSerializedCryptoKey(wrapped);
        if (!key)
            return std::nullopt;
        return WebCore::unwrapCryptoKey({ }, *key);
    }
};

UniqueRef<CryptoClient> createCryptoClient()
{
    return makeUniqueRef<EngineCryptoClient>();
}

} // namespace BrowserLite
