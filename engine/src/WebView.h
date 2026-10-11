// WebView: eine Seite (Tab) mit eigener WebCore::Page, Rendering in einen
// Pixel-Buffer und Eingabe-Events.
#pragma once

#include <WebCore/IntRect.h>
#include <WebCore/IntSize.h>
#include <WebCore/Region.h>
#include <wtf/CheckedRef.h>
#include <wtf/RefCounted.h>
#include <wtf/RefPtr.h>
#include <wtf/Vector.h>
#include <wtf/WeakPtr.h>
#include <wtf/text/WTFString.h>

class SkSurface;
template<typename> class sk_sp;

namespace WebCore {
class LocalFrame;
class LocalFrameView;
class Page;
}

namespace BrowserLite {

class WebView : public RefCounted<WebView>, public CanMakeWeakPtr<WebView> {
public:
    static Ref<WebView> create(int id, WebCore::IntSize, float deviceScaleFactor);
    ~WebView();

    static WebView* fromID(int);
    int id() const { return m_id; }

    WebCore::Page& page() { return *m_page; }
    WebCore::LocalFrame* mainFrame() const;
    WebCore::LocalFrameView* mainFrameView() const;

    // Laden
    void loadURL(const String&);
    void loadHTML(const String& html, const String& baseURL);
    void goBack();
    void goForward();
    void reload();
    void stop();
    String currentURL() const;
    String title() const;

    // Groesse in CSS-Pixeln, deviceScaleFactor fuer HiDPI
    void resize(WebCore::IntSize, float deviceScaleFactor);
    WebCore::IntSize size() const { return m_size; }

    // Rendering
    void addDamage(const WebCore::IntRect&);
    void scrollDamage(const WebCore::IntSize& delta, const WebCore::IntRect& rectToScroll, const WebCore::IntRect& clipRect);
    void scheduleRenderingUpdate();
    // Rendering-Update (rAF, Style, Layout) und neu malen was kaputt ist.
    // Gibt true zurueck, wenn sich Pixel geaendert haben.
    bool renderFrame(WebCore::IntRect* dirtyOut = nullptr);
    void framePresented() { m_frameInFlight = false; }
    bool frameInFlight() const { return m_frameInFlight; }
    void presentIfNeeded();

    const uint8_t* pixels() const { return m_pixels.span().data(); }
    WebCore::IntSize pixelSize() const { return m_pixelSize; }

    // Eingabe (Koordinaten in CSS-Pixeln relativ zur View)
    void mouseEvent(int type, int button, double x, double y, int clickCount, int modifiers);
    void wheelEvent(double x, double y, double deltaX, double deltaY, int modifiers);
    bool keyEvent(int type, const String& key, const String& code, const String& text, int keyCode, bool repeat, int modifiers);
    void setFocused(bool);

    // Fuer die Clients
    void didStartLoading();
    void didCommitLoad();
    void didFinishLoading();
    void didFailLoading(const String& url, const String& description);
    void didChangeTitle(const String&);
    void didChangeProgress(double);
    void didChangeCursor(const String& cssCursor);
    void didReceiveConsoleMessage(int level, const String& message, const String& source, unsigned line);
    bool isLoading() const { return m_isLoading; }

private:
    WebView(int id, WebCore::IntSize, float deviceScaleFactor);
    void createSurface();
    void notifyNavigationState();

    int m_id;
    WebCore::IntSize m_size;
    float m_deviceScaleFactor { 1 };
    WebCore::IntSize m_pixelSize;
    RefPtr<WebCore::Page> m_page;

    Vector<uint8_t> m_pixels;
    std::unique_ptr<sk_sp<SkSurface>> m_surface;
    WebCore::Region m_damage;
    bool m_renderingUpdateRequested { false };
    bool m_frameRequested { false };
    bool m_frameInFlight { false };
    bool m_isLoading { false };
};

} // namespace BrowserLite
