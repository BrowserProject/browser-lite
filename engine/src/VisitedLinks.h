// :visited of the pages: one store for all views, filled by WebCore's history with every address
// a frame commits and by the host with the addresses of its own history.
#pragma once

#include <wtf/Forward.h>

namespace WebCore {
class VisitedLinkStore;
}

namespace BrowserLite {

// The store every page gets (WebView.cpp)
WebCore::VisitedLinkStore& visitedLinkStore();

// bl_add_visited_links: addresses separated by newlines; open pages restyle their links to them
void addVisitedLinks(const String& urls);

// bl_clear_visited_links: no link counts as visited any more, open pages restyle their links
void clearVisitedLinks();

} // namespace BrowserLite
