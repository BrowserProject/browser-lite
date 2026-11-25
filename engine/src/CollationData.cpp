// The first Intl.Collator or localeCompare of a thread reads ICU's collation data: ucadata.icu
// and coll/root.res (0.94 MB of lazy/icu, tools/icu-data.mjs) and the file of its locale, one
// synchronous request each (open.spotify.com: 85 to 188 ms on the engine thread). The data stays
// lazy for the start and loads into memory once the first page finished loading.
#include "config.h"
#include "CollationData.h"

#include "LazyFiles.h"

#include <string>
#include <unicode/utypes.h>
#include <utility>
#include <vector>
#include <wtf/Language.h>
#include <wtf/text/WTFString.h>

namespace BrowserLite {

void preloadCollationData()
{
    static bool started;
    if (std::exchange(started, true))
        return;
    const std::string folder = "lazy/icu/" U_ICUDATA_NAME "/coll/";
    std::vector<std::string> paths { folder + "ucadata.icu", folder + "root.res" };
    // "de-CH" reads de_CH (missing, so no request) and de
    for (auto& language : WTF::userPreferredLanguages()) {
        String id = makeStringByReplacingAll(language, '-', '_');
        while (!id.isEmpty()) {
            paths.push_back(folder + id.utf8().data() + ".res");
            size_t cut = id.reverseFind('_');
            id = cut == notFound ? String() : id.left(cut);
        }
    }
    preloadLazyFiles(paths);
}

} // namespace BrowserLite
