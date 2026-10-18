// Gamepads through the host browser: the host polls navigator.getGamepads()
// every frame while a page uses gamepads and sends the state (bl_gamepad).
// Vibration goes to the host's vibrationActuator.
#include "config.h"
#include "Gamepad.h"

#include "Host.h"
#include <WebCore/GamepadEffectParameters.h>
#include <WebCore/GamepadHapticEffectType.h>
#include <WebCore/GamepadProvider.h>
#include <WebCore/GamepadProviderClient.h>
#include <WebCore/PlatformGamepad.h>
#include <WebCore/SharedGamepadValue.h>
#include <wtf/JSONValues.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/text/MakeString.h>

using namespace WebCore;

namespace BrowserLite {

class GamepadWasm final : public PlatformGamepad {
public:
    GamepadWasm(unsigned index, const String& id, const String& mapping, bool haptics)
        : PlatformGamepad(index)
    {
        m_id = id;
        m_mapping = mapping;
        m_connectTime = m_lastUpdateTime = MonotonicTime::now();
        if (haptics)
            m_supportedEffectTypes.add(GamepadHapticEffectType::DualRumble);
    }

    // true if a button is pressed (makes gamepads visible to the page)
    bool update(const Vector<double>& axes, const Vector<double>& buttons)
    {
        set(m_axes, axes);
        set(m_buttons, buttons);
        m_lastUpdateTime = MonotonicTime::now();
        return std::ranges::any_of(buttons, [](double value) { return value > 0.5; });
    }

private:
    static void set(Vector<SharedGamepadValue>& values, const Vector<double>& newValues)
    {
        while (values.size() < newValues.size())
            values.append(SharedGamepadValue { });
        values.shrink(newValues.size());
        for (size_t i = 0; i < newValues.size(); i++)
            values[i].setValue(newValues[i]);
    }

    const Vector<SharedGamepadValue>& axisValues() const final { return m_axes; }
    const Vector<SharedGamepadValue>& buttonValues() const final { return m_buttons; }
    ASCIILiteral source() const final { return "browser-lite"_s; }

    Vector<SharedGamepadValue> m_axes;
    Vector<SharedGamepadValue> m_buttons;
};

class GamepadProviderWasm final : public GamepadProvider {
public:
    void update(unsigned index, const JSON::Object& state)
    {
        if (index >= 16)
            return;
        bool connected = state.getBoolean("connected"_s).value_or(false);
        if (index >= m_gamepads.size())
            m_gamepads.resize(index + 1);
        auto& slot = m_gamepads[index];
        if (!connected) {
            if (!slot)
                return;
            auto gamepad = WTF::move(slot);
            syncList();
            for (Ref client : m_clients)
                client->platformGamepadDisconnected(*gamepad);
            return;
        }
        Vector<double> axes = numbers(state.getArray("axes"_s));
        Vector<double> buttons = numbers(state.getArray("buttons"_s));
        if (!slot) {
            slot = makeUnique<GamepadWasm>(index, state.getString("id"_s), state.getString("mapping"_s), state.getBoolean("haptics"_s).value_or(false));
            slot->update(axes, buttons);
            syncList();
            for (Ref client : m_clients)
                client->platformGamepadConnected(*slot, EventMakesGamepadsVisible::Yes);
            return;
        }
        if (slot->update(axes, buttons))
            setShouldMakeGamepadsVisibile();
        dispatchPlatformGamepadInputActivity();
    }

private:
    static Vector<double> numbers(RefPtr<JSON::Array>&& array)
    {
        Vector<double> result;
        if (!array)
            return result;
        for (auto& value : *array)
            result.append(value->asDouble().value_or(0));
        return result;
    }

    void syncList()
    {
        m_list.clear();
        for (auto& gamepad : m_gamepads)
            m_list.append(gamepad ? WeakPtr<PlatformGamepad> { *gamepad } : nullptr);
    }

    void startMonitoringGamepads(GamepadProviderClient& client) final
    {
        bool first = m_clients.isEmptyIgnoringNullReferences();
        m_clients.add(client);
        if (first)
            notifyHost(0, "gamepad-monitor", "{\"on\":true}"_s);
    }

    void stopMonitoringGamepads(GamepadProviderClient& client) final
    {
        m_clients.remove(client);
        if (m_clients.isEmptyIgnoringNullReferences())
            notifyHost(0, "gamepad-monitor", "{\"on\":false}"_s);
    }

    const Vector<WeakPtr<PlatformGamepad>>& platformGamepads() final { return m_list; }

    void playEffect(unsigned index, const String&, GamepadHapticEffectType type, const GamepadEffectParameters& parameters, CompletionHandler<void(bool)>&& completionHandler) final
    {
        notifyHost(0, "gamepad-effect", makeString("{\"index\":"_s, index, ",\"type\":\""_s,
            type == GamepadHapticEffectType::DualRumble ? "dual-rumble"_s : "trigger-rumble"_s,
            "\",\"duration\":"_s, parameters.duration, ",\"startDelay\":"_s, parameters.startDelay,
            ",\"strongMagnitude\":"_s, parameters.strongMagnitude, ",\"weakMagnitude\":"_s, parameters.weakMagnitude, '}'));
        completionHandler(true);
    }

    void stopEffects(unsigned index, const String&, CompletionHandler<void()>&& completionHandler) final
    {
        notifyHost(0, "gamepad-effect", makeString("{\"index\":"_s, index, ",\"type\":\"stop\"}"_s));
        completionHandler();
    }

    Vector<std::unique_ptr<GamepadWasm>> m_gamepads;
    Vector<WeakPtr<PlatformGamepad>> m_list;
};

static GamepadProviderWasm& provider()
{
    static NeverDestroyed<GamepadProviderWasm> provider;
    return provider;
}

void installGamepadProvider()
{
    GamepadProvider::setSharedProvider(provider());
}

void updateGamepad(unsigned index, const String& json)
{
    auto value = JSON::Value::parseJSON(json);
    if (!value)
        return;
    if (auto object = value->asObject())
        provider().update(index, *object);
}

} // namespace BrowserLite
