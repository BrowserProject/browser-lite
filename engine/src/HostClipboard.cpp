#include "config.h"
#include "HostClipboard.h"

#include "DeviceClients.h"
#include "Host.h"

#include <WebCore/WasmPlatform.h>
#include <wtf/HashMap.h>
#include <wtf/JSONValues.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/text/MakeString.h>

namespace BrowserLite {

void setClipboardFromHost(const String& json)
{
    WebCore::WasmPlatform::ClipboardItems items;
    Vector<String> files;
    auto value = JSON::Value::parseJSON(json);
    if (auto object = value ? value->asObject() : nullptr) {
        auto text = object->getString("text"_s);
        if (!text.isNull())
            items.append({ "text/plain;charset=utf-8"_s, text });
        auto html = object->getString("html"_s);
        if (!html.isEmpty())
            items.append({ "text/html"_s, html });
        if (auto array = object->getArray("files"_s)) {
            for (auto& file : *array)
                files.append(file->asString());
        }
    }
    WebCore::WasmPlatform::setClipboardFromHost(WTF::move(items), WTF::move(files));
}

static HashMap<int, CompletionHandler<void(bool)>>& pendingReads()
{
    static NeverDestroyed<HashMap<int, CompletionHandler<void(bool)>>> map;
    return map;
}

void requestHostClipboard(int viewId, const String& origin, CompletionHandler<void(bool)>&& completionHandler)
{
    requestDevicePermission(viewId, "clipboard-read"_s, origin, [viewId, completionHandler = WTF::move(completionHandler)](bool granted) mutable {
        if (!granted) {
            completionHandler(false);
            return;
        }
        static int nextRequestID = 1;
        int id = nextRequestID++;
        pendingReads().set(id, WTF::move(completionHandler));
        notifyHost(viewId, "clipboard-read", makeString("{\"id\":"_s, id, '}'));
    });
}

void answerClipboardRead(int requestId, const String& json)
{
    auto completionHandler = pendingReads().take(requestId);
    if (!completionHandler)
        return;
    if (json.isNull()) {
        completionHandler(false);
        return;
    }
    setClipboardFromHost(json);
    completionHandler(true);
}

} // namespace BrowserLite
