// Gamepads through the host browser (Gamepad.cpp)
#pragma once

#include <wtf/Forward.h>

namespace BrowserLite {

void installGamepadProvider();
// State of a gamepad as JSON: {connected, id, mapping, axes, buttons, haptics}
void updateGamepad(unsigned index, const String& json);

} // namespace BrowserLite
