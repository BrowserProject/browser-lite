#include "config.h"
#include "Printing.h"

#include "Host.h"
#include <WebCore/Document.h>
#include <WebCore/GraphicsContextSkia.h>
#include <WebCore/LocalFrame.h>
#include <WebCore/LocalFrameInlines.h>
#include <WebCore/DocumentPage.h>
#include <WebCore/DocumentView.h>
#include <WebCore/LocalFrameView.h>
#include <WebCore/Page.h>
#include <WebCore/PrintContext.h>
#include <WebCore/RenderView.h>
#include <skia/core/SkStream.h>
#include <skia/docs/SkPDFDocument.h>
#include <skia/docs/SkPDFJpegHelpers.h>
#include <wtf/text/CString.h>

namespace BrowserLite {
using namespace WebCore;

// A4 in Punkten (1/72 Zoll), Rand 1 cm wie die Standard-Raender von Chrome
static constexpr float paperWidth = 595.28f;
static constexpr float paperHeight = 841.89f;
static constexpr float margin = 28.35f;

void printFrame(int viewId, LocalFrame& frame)
{
    RefPtr page = frame.page();
    RefPtr document = frame.document();
    if (!page || !document || !frame.view())
        return;

    float contentWidth = paperWidth - 2 * margin;
    float contentHeight = paperHeight - 2 * margin;
    // Layout in CSS-Pixeln (96 pro Zoll) wie Chrome, gemalt wird in Punkten
    float widthInPixels = contentWidth * 96 / 72;
    float heightInPixels = contentHeight * 96 / 72;

    page->dispatchBeforePrintEvent();
    Ref printContext = PrintContext::create(&frame);
    printContext->begin(widthInPixels, heightInPixels);
    float fullPageHeight = 0;
    printContext->computePageRects(FloatRect(0, 0, widthInPixels, heightInPixels), 0, 0, 1, fullPageHeight);

    // Wie Chrome keine leere Seite am Schluss: WebKit kuerzt den unteren Rand
    // (z.B. von body) nach einem erzwungenen Seitenumbruch nicht weg
    size_t pageCount = printContext->pageCount();
    if (CheckedPtr renderView = document->renderView(); renderView && pageCount > 1 && renderView->writingMode().isHorizontal()) {
        int rest = renderView->documentRect().maxY() - printContext->pageRect(pageCount - 1).y();
        if (rest <= 10)
            --pageCount;
    }

    SkDynamicMemoryWStream stream;
    // JPEG-Bilder gehen unveraendert ins PDF, andere werden komprimiert (Skia verlangt beide Funktionen)
    auto metadata = SkPDF::JPEG::MetadataWithCallbacks();
    auto title = document->title().utf8();
    metadata.fTitle = SkString(title.data(), title.length());
    metadata.fCreator = SkString("browser-lite");
    auto pdf = SkPDF::MakeDocument(&stream, metadata);
    for (size_t index = 0; pdf && index < pageCount; ++index) {
        auto* canvas = pdf->beginPage(paperWidth, paperHeight);
        canvas->translate(margin, margin);
        GraphicsContextSkia context(*canvas, RenderingMode::Unaccelerated, RenderingPurpose::Unspecified);
        printContext->spoolPage(context, index, contentWidth);
        pdf->endPage();
    }
    if (pdf)
        pdf->close();
    printContext->end();
    page->dispatchAfterPrintEvent();

    auto data = stream.detachAsData();
    if (!data || !data->size())
        return;
    sendPrintDocument(viewId, { static_cast<const uint8_t*>(data->data()), data->size() }, document->title());
}

} // namespace BrowserLite
