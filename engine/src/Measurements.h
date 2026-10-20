// Readings for tests/perf only, read by the host with bl_measurements (only
// with BL_TEST_HOOKS=1): frames the compositor shows, start times of the
// engine and the size of the WebAssembly memory. They go away with tests/perf.
#pragma once

namespace BrowserLite::Measurements {

enum class Mark { Main, CompositorReady, Ready };
// Time of a step of the start (the first call counts)
void mark(Mark);

// Engine thread: a new video frame was painted, into the tiles of the
// rendering update that is being recorded (or by drawImage into a canvas)
void videoPainted();
// Engine thread: whether that happened since the last call
bool takeVideoPainted();

// Compositor thread: a frame is on screen; newContent when it shows a new
// video or WebGL image
void frameShown(bool newContent);

} // namespace BrowserLite::Measurements
