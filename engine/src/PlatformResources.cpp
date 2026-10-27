// Images WebCore asks the port for (ImageAdapter::loadPlatformResource, patch 0055): the broken
// image icon and the resize corner of text areas, WebCore's own PNGs in the data package
// (engine.cmake), like the GResources of GTK and WPE.

#include "config.h"

#include <WebCore/BitmapImage.h>
#include <WebCore/ImageAdapter.h>
#include <WebCore/SharedBuffer.h>
#include <wtf/text/MakeString.h>

namespace WebCore {

Ref<Image> ImageAdapter::loadPlatformResource(const char* name)
{
    auto image = BitmapImage::create();
    auto path = makeString("/usr/share/webkit/images/"_s, String::fromLatin1(name), ".png"_s);
    if (auto data = SharedBuffer::createWithContentsOfFile(path, FileSystem::MappedFileMode::Private, SharedBuffer::MayUseFileMapping::No))
        image->setData(data.releaseNonNull(), true);
    return image;
}

void ImageAdapter::invalidate()
{
}

} // namespace WebCore
