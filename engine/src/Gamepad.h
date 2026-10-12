// Gamepads ueber den Host-Browser (Gamepad.cpp)
#pragma once

#include <wtf/Forward.h>

namespace BrowserLite {

void installGamepadProvider();
// Zustand eines Gamepads als JSON: {connected, id, mapping, axes, buttons, haptics}
void updateGamepad(unsigned index, const String& json);

} // namespace BrowserLite
