const escapeHtml = (line: string) => line.replace(/&/g, '&amp;').replace(/</g, '&lt;');

/** Page with the source text of url, one numbered line each (Ctrl+U). */
export function sourcePage(url: string, text: string): { html: string; baseURL: string } {
  const lines = text
    .split(/\r?\n/)
    .map((line) => `<li>${escapeHtml(line)}</li>`)
    .join('');
  const html =
    `<!doctype html><meta charset="utf-8"><title>view-source:${escapeHtml(url)}</title>` +
    '<style>body{margin:8px 0;font:13px/1.5 ui-monospace,monospace;white-space:pre-wrap;word-break:break-all}' +
    `ol{margin:0;padding-left:5em}li{padding-left:1em}li::marker{color:#999}</style><ol>${lines}</ol>`;
  return { html, baseURL: `view-source:${url}` };
}
