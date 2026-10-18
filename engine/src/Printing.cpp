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

// A4 in points (1/72 inch), 1 cm margin like Chrome's default margins
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
    // Layout in CSS pixels (96 per inch) like Chrome, painting in points
    float widthInPixels = contentWidth * 96 / 72;
    float heightInPixels = contentHeight * 96 / 72;

    page->dispatchBeforePrintEvent();
    Ref printContext = PrintContext::create(&frame);
    printContext->begin(widthInPixels, heightInPixels);
    float fullPageHeight = 0;
    printContext->computePageRects(FloatRect(0, 0, widthInPixels, heightInPixels), 0, 0, 1, fullPageHeight);

    // Like Chrome no empty page at the end: WebKit does not cut off the bottom
    // margin (e.g. of body) after a forced page break
    size_t pageCount = printContext->pageCount();
    if (CheckedPtr renderView = document->renderView(); renderView && pageCount > 1 && renderView->writingMode().isHorizontal()) {
        int rest = renderView->documentRect().maxY() - printContext->pageRect(pageCount - 1).y();
        if (rest <= 10)
            --pageCount;
    }

    SkDynamicMemoryWStream stream;
    // JPEG images go into the PDF unchanged, others are compressed (Skia requires both functions)
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
