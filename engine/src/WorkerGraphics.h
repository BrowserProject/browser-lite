#pragma once

#include <memory>

namespace WebCore {
class WorkerClient;
}

namespace BrowserLite {

// Graphics of dedicated and shared workers (WorkerGraphics.cpp): WebGL on an OffscreenCanvas in
// a worker gets a context of the host's WebGL on the worker's own thread. Without a worker
// client WebCore creates no WebGL context in a worker.
std::unique_ptr<WebCore::WorkerClient> createWorkerGraphics();

} // namespace BrowserLite
