#include "config.h"
#include "UserContent.h"

#include "Host.h"
#include "WebPlatformExtras.h"
#include "WebView.h"

#include <JavaScriptCore/CallData.h>
#include <JavaScriptCore/JSCInlines.h>
#include <JavaScriptCore/JSLock.h>
#include <JavaScriptCore/JSNativeStdFunction.h>
#include <JavaScriptCore/ObjectConstructor.h>
#include <WebCore/CommonVM.h>
#include <WebCore/DOMWrapperWorld.h>
#include <WebCore/FrameInlines.h>
#include <WebCore/FrameTree.h>
#include <WebCore/JSDOMExceptionHandling.h>
#include <WebCore/JSDOMGlobalObject.h>
#include <WebCore/JSExecState.h>
#include <WebCore/JSWindowProxy.h>
#include <WebCore/LocalFrame.h>
#include <WebCore/Page.h>
#include <WebCore/ScriptController.h>
#include <WebCore/ScriptExecutionContext.h>
#include <WebCore/UserContentController.h>
#include <WebCore/UserScript.h>
#include <WebCore/UserStyleSheet.h>
#include <WebCore/WindowProxy.h>
#include <wtf/HashMap.h>
#include <wtf/JSONValues.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/text/MakeString.h>

namespace BrowserLite {

using namespace WebCore;

// Shared by all pages, created with the first content
static RefPtr<UserContentController>& controller()
{
    static NeverDestroyed<RefPtr<UserContentController>> controller;
    return controller;
}

// One isolated world per extension id, kept for the life of the engine
static HashMap<String, Ref<DOMWrapperWorld>>& worlds()
{
    static NeverDestroyed<HashMap<String, Ref<DOMWrapperWorld>>> worlds;
    return worlds;
}

static DOMWrapperWorld& worldOf(const String& extension)
{
    return worlds().ensure(extension, [&] {
        return DOMWrapperWorld::create(commonVM(), DOMWrapperWorld::Type::User, extension);
    }).iterator->value.get();
}

static Vector<String> stringList(const JSON::Object& object, const String& key)
{
    Vector<String> result;
    if (auto array = object.getArray(key)) {
        for (auto& item : *array) {
            auto text = item->asString();
            if (!text.isNull())
                result.append(text);
        }
    }
    return result;
}

static UserContentInjectedFrames injectedFrames(const JSON::Object& object)
{
    return object.getBoolean("allFrames"_s).value_or(false) ? UserContentInjectedFrames::InjectInAllFrames : UserContentInjectedFrames::InjectInTopFrameOnly;
}

// Shown in stack traces and console messages of the content
static URL contentURL(const String& extension, ASCIILiteral kind, unsigned index)
{
    return URL { makeString("browser-lite-extension://"_s, extension, '/', kind, '-', index) };
}

// [{extension, scripts: [{source, matches, excludes, runAt, allFrames, world}],
//   styles: [{source, matches, excludes, allFrames}]}]
void setUserContent(const String& json)
{
    auto value = JSON::Value::parseJSON(json);
    auto entries = value ? value->asArray() : nullptr;
    if (!entries)
        return;
    auto& provider = controller();
    if (!provider) {
        if (!entries->length())
            return;
        provider = UserContentController::create();
        WebView::forEach([&](WebView& view) { view.page().setUserContentProviderForWebKitLegacy(*provider); });
    }
    provider->removeAllUserContent();
    for (auto& entry : *entries) {
        auto object = entry->asObject();
        auto extension = object ? object->getString("extension"_s) : String { };
        if (extension.isEmpty())
            continue;
        auto& isolated = worldOf(extension);
        unsigned index = 0;
        if (auto scripts = object->getArray("scripts"_s)) {
            for (auto& item : *scripts) {
                auto script = item->asObject();
                if (!script)
                    continue;
                auto& world = script->getString("world"_s) == "main"_s ? mainThreadNormalWorldSingleton() : isolated;
                auto time = script->getString("runAt"_s) == "document-start"_s ? UserScriptInjectionTime::DocumentStart : UserScriptInjectionTime::DocumentEnd;
                provider->addUserScript(world, makeUnique<UserScript>(script->getString("source"_s), contentURL(extension, "script"_s, index++),
                    stringList(*script, "matches"_s), stringList(*script, "excludes"_s), time, injectedFrames(*script)));
            }
        }
        index = 0;
        if (auto styles = object->getArray("styles"_s)) {
            for (auto& item : *styles) {
                auto style = item->asObject();
                if (!style)
                    continue;
                provider->addUserStyleSheet(isolated, makeUnique<UserStyleSheet>(style->getString("source"_s), contentURL(extension, "style"_s, index++),
                    stringList(*style, "matches"_s), stringList(*style, "excludes"_s), injectedFrames(*style)), InjectInExistingDocuments);
            }
        }
    }
}

void attachUserContent(Page& page)
{
    if (auto& provider = controller())
        page.setUserContentProviderForWebKitLegacy(*provider);
}

// ---------------------------------------------------------------- Bridge

// The function of the bridge that delivers messages of the host, stored on
// the global object of the world under a private name
static const JSC::Identifier& receiverName()
{
    static NeverDestroyed<JSC::Identifier> name = JSC::Identifier::fromUid(JSC::PrivateName(JSC::PrivateName::PrivateSymbol, "blExtensionReceiver"_s));
    return name;
}

// Runs in every window of an extension's world before its scripts, called with
// the bridge {id, send(json, callback), receive(function)}. The global
// `extension` exists only in this world, the page never sees it.
static constexpr auto bridgeSource = R"JS((bridge) => {
  const listeners = new Set();
  const failure = (json) => {
    let data = null;
    try {
      data = JSON.parse(json);
    } catch {}
    const error = new Error(String(data?.message ?? 'The extension did not answer'));
    error.name = String(data?.name ?? 'Error');
    return error;
  };
  const extension = Object.freeze({
    id: bridge.id,
    sendMessage: (message) =>
      new Promise((resolve, reject) => {
        bridge.send(JSON.stringify(message ?? null), (ok, json) => {
          if (ok) resolve(JSON.parse(json));
          else reject(failure(json));
        });
      }),
    onMessage: Object.freeze({
      addListener(listener) {
        if (typeof listener === 'function') listeners.add(listener);
      },
      removeListener(listener) {
        listeners.delete(listener);
      },
    }),
  });
  Object.defineProperty(globalThis, 'extension', { value: extension });
  bridge.receive((json) => {
    const message = JSON.parse(json);
    for (const listener of [...listeners]) {
      try {
        listener(message);
      } catch (error) {
        reportError(error);
      }
    }
  });
})JS";

static String extensionOfWorld(DOMWrapperWorld& world)
{
    if (!world.isUser())
        return { };
    auto entry = worlds().find(world.name());
    return entry != worlds().end() && entry->value.ptr() == &world ? world.name() : String { };
}

static JSC::JSObject* createSender(JSC::JSGlobalObject& globalObject, int viewId, const String& extension)
{
    auto& vm = globalObject.vm();
    return JSC::JSNativeStdFunction::create(vm, &globalObject, 2, "send"_s, [viewId, extension](JSC::JSGlobalObject* globalObject, JSC::CallFrame* callFrame) -> JSC::EncodedJSValue {
        auto& vm = globalObject->vm();
        auto scope = DECLARE_THROW_SCOPE(vm);
        auto message = callFrame->argument(0).toWTFString(globalObject);
        RETURN_IF_EXCEPTION(scope, { });
        auto* callback = callFrame->argument(1).getObject();
        if (!callback || !callback->isCallable())
            return JSC::JSValue::encode(JSC::jsUndefined());
        auto identifier = addHostCall(*globalObject, *callback);
        String url;
        if (auto* domGlobalObject = dynamicDowncast<JSDOMGlobalObject>(globalObject)) {
            if (RefPtr context = domGlobalObject->scriptExecutionContext())
                url = context->url().string();
        }
        notifyHost(viewId, "extension-message", makeString("{\"id\":"_s, identifier, ",\"extension\":\""_s, jsonEscape(extension), "\",\"url\":\""_s, jsonEscape(url), "\",\"message\":\""_s, jsonEscape(message), "\"}"_s));
        return JSC::JSValue::encode(JSC::jsUndefined());
    });
}

static JSC::JSObject* createReceiverSetter(JSC::JSGlobalObject& globalObject)
{
    auto& vm = globalObject.vm();
    return JSC::JSNativeStdFunction::create(vm, &globalObject, 1, "receive"_s, [](JSC::JSGlobalObject* globalObject, JSC::CallFrame* callFrame) -> JSC::EncodedJSValue {
        auto& vm = globalObject->vm();
        auto* receiver = callFrame->argument(0).getObject();
        if (receiver && receiver->isCallable() && !globalObject->getDirect(vm, receiverName()))
            globalObject->putDirect(vm, receiverName(), receiver, static_cast<unsigned>(JSC::PropertyAttribute::DontEnum));
        return JSC::JSValue::encode(JSC::jsUndefined());
    });
}

void installExtensionBridge(LocalFrame& frame, DOMWrapperWorld& world, int viewId)
{
    auto extension = extensionOfWorld(world);
    if (extension.isNull())
        return;
    auto* globalObject = frame.script().globalObject(world);
    if (!globalObject)
        return;
    auto& vm = globalObject->vm();
    JSC::JSLockHolder lock(vm);
    // The window object can be announced as cleared more than once
    if (globalObject->getDirect(vm, receiverName()))
        return;
    auto* bridge = JSC::constructEmptyObject(vm, globalObject->nullPrototypeObjectStructure());
    bridge->putDirect(vm, JSC::Identifier::fromString(vm, "id"_s), JSC::jsString(vm, extension));
    bridge->putDirect(vm, JSC::Identifier::fromString(vm, "send"_s), createSender(*globalObject, viewId, extension));
    bridge->putDirect(vm, JSC::Identifier::fromString(vm, "receive"_s), createReceiverSetter(*globalObject));
    JSC::MarkedArgumentBuffer arguments;
    arguments.append(bridge);
    callEngineFunction(*globalObject, String::fromUTF8(bridgeSource), arguments);
}

void sendExtensionMessage(WebView& view, const String& extension, const String& json)
{
    auto world = worlds().find(extension);
    if (world == worlds().end())
        return;
    // Listeners may change the frame tree
    Vector<Ref<LocalFrame>> frames;
    for (RefPtr<Frame> frame = view.page().mainFrame(); frame; frame = frame->tree().traverseNext()) {
        if (RefPtr localFrame = dynamicDowncast<LocalFrame>(*frame))
            frames.append(localFrame.releaseNonNull());
    }
    for (auto& frame : frames) {
        auto* proxy = frame->windowProxy().existingJSWindowProxy(world->value);
        auto* globalObject = proxy ? proxy->window() : nullptr;
        if (!globalObject)
            continue;
        auto& vm = globalObject->vm();
        JSC::JSLockHolder lock(vm);
        auto receiver = globalObject->getDirect(vm, receiverName());
        if (!receiver || !receiver.isCallable())
            continue;
        auto callData = JSC::getCallData(receiver);
        JSC::MarkedArgumentBuffer arguments;
        arguments.append(JSC::jsString(vm, json));
        NakedPtr<JSC::Exception> exception;
        JSExecState::profiledCall(globalObject, JSC::ProfilingReason::Other, receiver, callData, JSC::jsUndefined(), arguments, exception);
        if (exception)
            reportException(globalObject, exception);
    }
}

} // namespace BrowserLite
