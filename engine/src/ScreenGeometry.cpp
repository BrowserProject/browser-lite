#include "config.h"
#include "ScreenGeometry.h"

#include <wtf/HashMap.h>
#include <wtf/Lock.h>
#include <wtf/NeverDestroyed.h>

namespace BrowserLite::ScreenGeometry {

using namespace WebCore;

static Lock s_lock;
static std::optional<FloatRect> s_window WTF_GUARDED_BY_LOCK(s_lock);

static HashMap<int, FloatPoint>& origins() WTF_REQUIRES_LOCK(s_lock)
{
    static NeverDestroyed<HashMap<int, FloatPoint>> origins;
    return origins;
}

void setWindow(const FloatRect& rect)
{
    Locker locker { s_lock };
    s_window = rect;
}

FloatRect window(const FloatSize& viewSize)
{
    Locker locker { s_lock };
    if (!s_window)
        return { { }, viewSize };
    return { s_window->location(), s_window->size().expandedTo(viewSize) };
}

void setViewOrigin(int viewId, const FloatPoint& origin)
{
    Locker locker { s_lock };
    origins().set(viewId, origin);
}

void forgetView(int viewId)
{
    Locker locker { s_lock };
    origins().remove(viewId);
}

static FloatPoint originOf(int viewId)
{
    Locker locker { s_lock };
    return origins().get(viewId);
}

DoublePoint toScreen(int viewId, const DoublePoint& point)
{
    auto origin = originOf(viewId);
    return { point.x() + origin.x(), point.y() + origin.y() };
}

DoublePoint fromScreen(int viewId, const DoublePoint& point)
{
    auto origin = originOf(viewId);
    return { point.x() - origin.x(), point.y() - origin.y() };
}

} // namespace BrowserLite::ScreenGeometry
