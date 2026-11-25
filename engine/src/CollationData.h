// ICU's collation data (lazy/icu, 0.94 MB) in memory ahead of the first Intl.Collator
// (CollationData.cpp).
#pragma once

namespace BrowserLite {

// Once the first page finished loading: fetches the collation data of the root locale and of the
// pages' languages into memory in the background. Later calls do nothing. On the engine thread.
void preloadCollationData();

} // namespace BrowserLite
