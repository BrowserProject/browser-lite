// @ts-check
// Media part of a service worker for @browser-lite/core. Load it with
// importScripts('media-sw.js') from your own service worker. It serves the URLs below
// `bl-media/` relative to the registration scope to the hidden <video> elements of the core:
// the bytes come from the engine chunk by chunk (range requests through the transport), the
// next chunk only when the media element reads, so a long video never sits in memory.
// It adds its own fetch and message listeners and ignores everything else.

(() => {
  const sw = /** @type {ServiceWorkerGlobalScope} */ (/** @type {unknown} */ (self));
  const CHUNK = 2 * 1024 * 1024;
  const HEAD_TIMEOUT = 30000;
  const prefix = new URL('bl-media/', sw.registration.scope).pathname;

  /**
   * @typedef {{ status: number, range?: string, type?: string, length?: string, error?: string }} Head
   * @typedef {{
   *   instance: string,
   *   client: Client | null,
   *   onHead(head: Head): void,
   *   onData(bytes: Uint8Array): void,
   *   onEnd(): void,
   *   onError(message: string): void,
   * }} Fetch
   */

  let nextFetchId = 1;
  /** @type {Map<number, Fetch>} */
  const fetches = new Map();
  /** Browser instance id -> client id of the page that runs it. */
  /** @type {Map<string, string>} */
  const instances = new Map();

  sw.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || typeof message.bl !== 'string' || typeof message.instance !== 'string') return;
    const source = /** @type {Client | null} */ (event.source);
    if (source && 'id' in source) instances.set(message.instance, source.id);
    if (message.bl !== 'media-data') return;
    const handler = fetches.get(message.id);
    if (!handler || handler.instance !== message.instance) return;
    handler.client = source;
    if (message.type === 'head') handler.onHead(message.data);
    else if (message.type === 'data') handler.onData(new Uint8Array(message.bytes));
    else if (message.type === 'end') handler.onEnd();
    else handler.onError(message.data?.message || 'Media fetch failed');
  });

  sw.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    if (url.origin !== sw.location.origin || !url.pathname.startsWith(prefix)) return;
    const [instance = '', player = ''] = url.pathname.slice(prefix.length).split('/');
    if (!instance || !/^\d+$/.test(player)) return;
    event.respondWith(mediaResponse(event, instance, Number(player)));
  });

  /**
   * The page of the instance; null means: ask all window clients (the right one answers).
   * @param {FetchEvent} event
   * @param {string} instance
   * @returns {Promise<Client | null>}
   */
  async function pageClient(event, instance) {
    for (const id of [instances.get(instance), event.clientId]) {
      if (!id) continue;
      const client = await sw.clients.get(id);
      if (client) return client;
    }
    return null;
  }

  /**
   * @param {Client | null} client
   * @param {unknown} message
   */
  async function post(client, message) {
    if (client) {
      client.postMessage(message);
      return;
    }
    for (const window of await sw.clients.matchAll({ type: 'window' })) window.postMessage(message);
  }

  /**
   * Fetches [start, end] of a player from the engine. Calls onHead once, then onData.
   * @param {Client | null} client
   * @param {string} instance
   * @param {number} player
   * @param {number} start
   * @param {number} end
   * @param {Omit<Fetch, 'instance' | 'client'>} callbacks
   */
  function engineFetch(client, instance, player, start, end, callbacks) {
    const id = nextFetchId++;
    /** @type {Fetch} */
    const handler = { instance, client, ...callbacks };
    fetches.set(id, handler);
    post(client, { bl: 'media-fetch', instance, id, player, start, end });
    return {
      cancel() {
        fetches.delete(id);
        post(handler.client, { bl: 'media-cancel', instance, id });
      },
      done() {
        fetches.delete(id);
      },
    };
  }

  /** @param {string | null} header */
  function parseRange(header) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(header || '');
    if (!match) return { start: 0, end: -1 };
    return { start: match[1] ? Number(match[1]) : 0, end: match[2] ? Number(match[2]) : -1 };
  }

  /**
   * @param {FetchEvent} event
   * @param {string} instance
   * @param {number} player
   * @returns {Promise<Response>}
   */
  async function mediaResponse(event, instance, player) {
    const client = await pageClient(event, instance);
    if (!client && !(await sw.clients.matchAll({ type: 'window' })).length)
      return new Response('No page for this media request', { status: 503 });
    const range = parseRange(event.request.headers.get('Range'));
    const wantsRange = event.request.headers.has('Range');

    // The first chunk tells whether the server supports ranges
    let position = range.start;
    const firstEnd =
      range.end >= 0 ? Math.min(range.end, position + CHUNK - 1) : position + CHUNK - 1;
    /** @type {{ cancel(): void, done(): void } | null} */
    let current = null;
    let total = -1;
    /** @type {ReadableStreamDefaultController<Uint8Array> | null} */
    let streamController = null;
    let finished = false;
    let waitingForPull = false;
    /** @type {RegExpExecArray | null} */
    let rangeMatch = null;
    let chunked = false;
    let lastByte = Infinity;
    // Messages that arrive before the response body exists run once it does, in order
    /** @type {(() => void)[] | null} */
    let early = [];
    /** @param {() => void} fn */
    const deliver = (fn) => (early ? early.push(fn) : fn());

    /** @type {Head} */
    const head = await new Promise((resolve) => {
      // An instance that is gone (page reloaded) never answers
      const timer = setTimeout(() => {
        current?.cancel();
        resolve({ status: 504, error: 'No answer from the page' });
      }, HEAD_TIMEOUT);
      current = engineFetch(client, instance, player, position, firstEnd, {
        onHead: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        onData: (bytes) =>
          deliver(() => {
            position += bytes.length;
            streamController?.enqueue(bytes);
          }),
        onEnd: () => deliver(() => chunkDone(range.start, firstEnd)),
        onError: (message) => {
          clearTimeout(timer);
          resolve({ status: 502, error: message });
          deliver(() => fail(message));
        },
      });
    });
    if (head.error) return new Response(head.error, { status: head.status });

    // 206 with Content-Range: the rest can be loaded in chunks
    rangeMatch = /bytes (\d+)-(\d+)\/(\d+|\*)/.exec(head.range || '');
    chunked = head.status === 206 && !!rangeMatch;
    if (chunked && rangeMatch?.[3] !== '*') total = Number(rangeMatch?.[3]);
    // Without a known length (bytes a-b/*) and an open range only the first chunk; the
    // media element asks again for the rest
    lastByte = range.end >= 0 ? range.end : Infinity;
    if (total >= 0) lastByte = Math.min(lastByte, total - 1);
    else if (chunked && wantsRange && range.end < 0) lastByte = Number(rangeMatch?.[2]);

    /**
     * @param {number} start
     * @param {number} end
     */
    function chunkDone(start, end) {
      current?.done();
      current = null;
      // Done: everything there, no progress, or without a known length a shorter chunk
      // than requested (end of file)
      if (!chunked || position > lastByte || position === start || (total < 0 && position <= end)) {
        finish();
        return;
      }
      if (streamController && (streamController.desiredSize ?? 0) > 0) fetchNext();
      else waitingForPull = true;
    }

    function finish() {
      finished = true;
      try {
        streamController?.close();
      } catch {}
    }

    /** @param {string} message */
    function fail(message) {
      finished = true;
      try {
        streamController?.error(new Error(message));
      } catch {}
    }

    function fetchNext() {
      waitingForPull = false;
      const start = position;
      const end = Math.min(lastByte, position + CHUNK - 1);
      const request = engineFetch(client, instance, player, start, end, {
        onHead: (next) => {
          if (next.status === 206) return;
          request.cancel();
          current = null;
          // 416 means past the end. Without a known length any other status also ends the
          // file, otherwise the file changed.
          if (next.status === 416 || total < 0) finish();
          else fail('Range requests no longer supported');
        },
        onData: (bytes) => {
          position += bytes.length;
          streamController?.enqueue(bytes);
        },
        onEnd: () => chunkDone(start, end),
        onError: fail,
      });
      current = request;
    }

    const body = new ReadableStream(
      {
        start(controller) {
          streamController = controller;
          const queued = early ?? [];
          early = null;
          for (const fn of queued) fn();
          if (waitingForPull && (controller.desiredSize ?? 0) > 0) queueMicrotask(fetchNext);
        },
        pull() {
          if (!finished && waitingForPull) fetchNext();
        },
        cancel() {
          finished = true;
          current?.cancel();
          current = null;
        },
      },
      { highWaterMark: CHUNK, size: (chunk) => chunk.length },
    );

    const headers = new Headers();
    headers.set('Content-Type', head.type || 'application/octet-stream');
    headers.set('Accept-Ranges', chunked ? 'bytes' : 'none');
    headers.set('Cache-Control', 'no-store');
    let status = 200;
    if (chunked && wantsRange) {
      status = 206;
      headers.set('Content-Range', `bytes ${range.start}-${lastByte}/${total >= 0 ? total : '*'}`);
      if (total >= 0) headers.set('Content-Length', String(lastByte - range.start + 1));
    } else if (chunked && total >= 0) {
      headers.set('Content-Length', String(total));
    } else if (head.length) {
      headers.set('Content-Length', head.length);
    }
    if (!chunked && head.status >= 400) status = head.status;
    return new Response(body, { status, headers });
  }
})();
