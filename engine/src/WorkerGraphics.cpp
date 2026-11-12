// WebGL in workers like Chrome and Firefox (#528). Every engine thread is a Web Worker of the
// host, so the ANGLE replacement (patch 0016) runs there as on the engine thread: the worker's
// thread gets its own host WebGL contexts, one per version, shared by all its contexts. WebCore
// asks the worker client of the worker for them, WebKit2's WebWorkerClient gives none without
// its GPU process because ANGLE is not thread safe.
#include "config.h"
#include "WorkerGraphics.h"

#include <WebCore/GraphicsContextGL.h>
#include <WebCore/GraphicsContextGLAttributes.h>
#include <WebCore/ImageBuffer.h>
#include <WebCore/WorkerClient.h>
#include <wtf/TZoneMallocInlines.h>

using namespace WebCore;

namespace BrowserLite {

class WorkerGraphics final : public WorkerClient {
    WTF_MAKE_TZONE_ALLOCATED_INLINE(WorkerGraphics);
public:
    UniqueRef<WorkerClient> createNestedWorkerClient(SerialFunctionDispatcher&) final
    {
        return makeUniqueRef<WorkerGraphics>();
    }

    PlatformDisplayID displayID() const final { return 0; }

#if ENABLE(WEBGL)
    RefPtr<GraphicsContextGL> createGraphicsContextGL(const GraphicsContextGLAttributes& attributes) const final
    {
        return createWebProcessGraphicsContextGL(attributes);
    }
#endif

private:
    // Image buffers as without a client
    RefPtr<ImageBuffer> createImageBuffer(const FloatSize&, RenderingMode, RenderingPurpose, float, const DestinationColorSpace&, ImageBufferFormat) const final
    {
        return nullptr;
    }

    RefPtr<ImageBuffer> sinkIntoImageBuffer(std::unique_ptr<SerializedImageBuffer> buffer) final
    {
        return SerializedImageBuffer::sinkIntoImageBuffer(WTF::move(buffer));
    }
};

std::unique_ptr<WorkerClient> createWorkerGraphics()
{
    return makeUnique<WorkerGraphics>();
}

} // namespace BrowserLite
