import { setStatus } from './toolbar.js';
import { byId } from './util.js';

const preview = byId('print-preview');
let pdfUrl: string | null = null;
let fileName = 'Page.pdf';
let afterClose: () => void = () => {};

/** Called after the preview closed (keyboard back into the page). */
export function onPreviewClosed(listener: () => void): void {
  afterClose = listener;
}

export function previewOpen(): boolean {
  return !preview.hidden;
}

/** Status while the engine builds the PDF (view.print()). */
export function printing(): void {
  setStatus('Building print preview…');
}

export function closePreview(): void {
  if (preview.hidden) return;
  preview.hidden = true;
  preview.querySelector('iframe')?.remove();
  if (pdfUrl) URL.revokeObjectURL(pdfUrl);
  pdfUrl = null;
  afterClose();
}

const print = (frame: HTMLIFrameElement | null) => {
  try {
    frame?.contentWindow?.print();
  } catch {}
};

/** Shows the PDF of the engine like the print preview of Chrome and opens the print dialog. */
export function showPreview(pdf: Blob, title: string): void {
  setStatus('');
  closePreview();
  pdfUrl = URL.createObjectURL(pdf);
  fileName = `${(title || 'Page').replace(/[\\/:*?"<>|]+/g, ' ').trim()}.pdf`;
  const heading = preview.querySelector('.print-title');
  if (heading) heading.textContent = title || 'Print';
  const frame = document.createElement('iframe');
  frame.title = 'Print preview';
  frame.src = pdfUrl;
  // Like window.print() in Chrome: the print dialog comes at once
  frame.addEventListener('load', () => print(frame), { once: true });
  preview.append(frame);
  preview.hidden = false;
}

// "Save as PDF" with the download of the host browser
function save(): void {
  if (!pdfUrl) return;
  const link = document.createElement('a');
  link.href = pdfUrl;
  link.download = fileName;
  link.click();
}

preview.querySelector('.print-close')?.addEventListener('click', closePreview);
preview.querySelector('.print-save')?.addEventListener('click', save);
preview
  .querySelector('.print-now')
  ?.addEventListener('click', () => print(preview.querySelector('iframe')));
