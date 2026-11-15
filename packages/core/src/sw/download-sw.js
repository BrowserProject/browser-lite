// @ts-check
// Download part of a service worker for @browser-lite/core. Load it with
// importScripts('download-sw.js') from your own service worker. It streams the downloads of the
// pages into the downloads of the host browser: the core opens a download by message, then (once
// this worker answers) navigates a hidden frame to its URL below `bl-download/` relative to the
// registration scope, and this worker
// answers that navigation with an attachment whose body is the stream of the bytes the core posts,
// so a large file never sits in the memory of the page. It adds its own fetch and message
// listeners and ignores everything else.

(() => {
  const sw = /** @type {ServiceWorkerGlobalScope} */ (/** @type {unknown} */ (self));
  const prefix = new URL('bl-download/', sw.registration.scope).pathname;

  /**
   * @typedef {{
   *   filename: string,
   *   mime: string,
   *   client: Client | null,
   *   body: ReadableStream<Uint8Array>,
   *   controller: ReadableStreamDefaultController<Uint8Array>,
   *   fetched: boolean,
   * }} Download
   */

  /** Open downloads by `<instance>/<id>`. */
  /** @type {Map<string, Download>} */
  const downloads = new Map();

  sw.addEventListener('message', (event) => {
    const message = event.data;
    if (
      !message ||
      typeof message.bl !== 'string' ||
      !message.bl.startsWith('download-') ||
      typeof message.instance !== 'string'
    )
      return;
    const key = `${message.instance}/${message.id}`;
    if (message.bl === 'download-open') {
      open(key, message, /** @type {Client | null} */ (event.source));
      return;
    }
    const download = downloads.get(key);
    if (!download) return;
    if (message.bl === 'download-data') {
      download.controller.enqueue(new Uint8Array(message.bytes));
    } else if (message.bl === 'download-end') {
      downloads.delete(key);
      try {
        if (message.error) download.controller.error(new Error(String(message.error)));
        else download.controller.close();
      } catch {}
    }
  });

  /**
   * @param {string} key
   * @param {{ instance: string, id: number, filename?: unknown, mime?: unknown }} message
   * @param {Client | null} client
   */
  function open(key, message, client) {
    /** @type {ReadableStreamDefaultController<Uint8Array> | undefined} */
    let controller;
    const body = new ReadableStream({
      start(c) {
        controller = c;
      },
      // The download was cancelled in the host browser: the core ends it in the engine
      cancel() {
        if (downloads.get(key)?.body !== body) return;
        downloads.delete(key);
        client?.postMessage({ bl: 'download-cancel', instance: message.instance, id: message.id });
      },
    });
    if (!controller) return;
    downloads.set(key, {
      filename: String(message.filename || 'download'),
      mime: String(message.mime || ''),
      client,
      body,
      controller,
      fetched: false,
    });
    // Only now the page navigates its frame: a message and a fetch event have no order
    client?.postMessage({ bl: 'download-opened', instance: message.instance, id: message.id });
  }

  sw.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    if (url.origin !== sw.location.origin || !url.pathname.startsWith(prefix)) return;
    const [instance = '', id = ''] = url.pathname.slice(prefix.length).split('/');
    const download = downloads.get(`${instance}/${id}`);
    // Each download is answered once, to the frame of the core
    if (!download || download.fetched || event.request.mode !== 'navigate') {
      event.respondWith(new Response('No such download', { status: 404, headers: headers('') }));
      return;
    }
    download.fetched = true;
    const response = new Response(download.body, {
      headers: headers(download.mime, download.filename),
    });
    event.respondWith(response);
    download.client?.postMessage({ bl: 'download-started', instance, id: Number(id) });
  });

  /**
   * Headers of a download: always an attachment, also for HTML, and a sandbox in case a browser
   * showed it anyway (the bytes come from the pages, never from this origin). COEP and CORP keep it
   * loadable in the cross-origin isolated page. No Content-Length: the engine's expected size is
   * that of the response before its Content-Encoding.
   * @param {string} mime
   * @param {string} [filename]
   */
  function headers(mime, filename) {
    const result = new Headers({
      'Content-Type': 'application/octet-stream',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': 'sandbox',
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'same-origin',
    });
    try {
      if (mime) result.set('Content-Type', mime);
    } catch {}
    if (filename !== undefined) result.set('Content-Disposition', disposition(filename));
    return result;
  }

  /**
   * `attachment` with the name as UTF-8 (RFC 6266) and an ASCII fallback.
   * @param {string} filename
   */
  function disposition(filename) {
    const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
    const utf8 = encodeURIComponent(filename).replace(
      /['()*]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    );
    return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
  }
})();
