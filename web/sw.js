// Service Worker: liefert die Daten fuer <video>/<audio> der Seiten in der Engine.
//
// Das versteckte <video> der Oberflaeche (media.js) laedt bl-media/<player>/...
// Hier wird daraus eine Antwort, deren Daten die Engine Stueck fuer Stueck
// ueber das Relay laedt (Range-Requests). Das naechste Stueck wird erst geholt,
// wenn der Browser die Daten auch liest. So kommt ein langes Video nie ganz in
// den Speicher. Alles andere geht normal ans Netz.
//
// Dazu PDFs im Tab (app.js showPDF): bl-pdf/<id>/<name>.pdf, damit der
// PDF-Viewer des Browsers den richtigen Dateinamen zeigt und speichert. Die
// Daten holen wir jedes Mal bei der Oberflaeche (der Worker kann jederzeit
// beendet werden).

const PREFIX = '/bl-media/';
const CHUNK = 2 * 1024 * 1024;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

let nextFetchId = 1;
const fetches = new Map(); // id -> { onHead, onData, onEnd, onError }

self.addEventListener('message', (event) => {
  const message = event.data;
  if (!message || message.bl !== 'fetch')
    return;
  const handler = fetches.get(message.id);
  if (!handler)
    return;
  if (message.type === 'head')
    handler.onHead(message.data);
  else if (message.type === 'data')
    handler.onData(new Uint8Array(message.bytes));
  else if (message.type === 'end')
    handler.onEnd();
  else
    handler.onError(message.data?.message || 'Fehler');
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const pdfPrefix = new URL('bl-pdf/', self.registration.scope).pathname;
  if (url.origin === location.origin && url.pathname.startsWith(pdfPrefix)) {
    event.respondWith(pdfResponse(url.pathname.slice(pdfPrefix.length).split('/')[0]));
    return;
  }
  if (url.origin !== location.origin || !url.pathname.startsWith(PREFIX))
    return;
  event.respondWith(mediaResponse(event, Number(url.pathname.slice(PREFIX.length).split('/')[0])));
});

async function pageClient(event) {
  if (event.clientId) {
    const client = await self.clients.get(event.clientId);
    if (client)
      return client;
  }
  // Media-Anfragen haben manchmal keine clientId: dann das sichtbare Fenster
  const all = await self.clients.matchAll({ type: 'window' });
  return all.find((c) => c.visibilityState === 'visible') || all[0];
}

async function pdfResponse(id) {
  const windows = (await self.clients.matchAll({ type: 'window' })).filter((c) => c.frameType === 'top-level');
  windows.sort((a, b) => (b.visibilityState === 'visible') - (a.visibilityState === 'visible'));
  for (const client of windows) {
    const blob = await new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = (event) => resolve(event.data?.blob || null);
      client.postMessage({ bl: 'pdf-get', id }, [channel.port2]);
      setTimeout(() => resolve(null), 5000);
    });
    if (blob) {
      // Die Oberflaeche laeuft mit COOP/COEP: das iframe-Dokument braucht die Header auch
      return new Response(blob, { headers: { 'Content-Type': 'application/pdf', 'Content-Length': String(blob.size),
        'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': 'same-origin', 'Cross-Origin-Opener-Policy': 'same-origin' } });
    }
  }
  return new Response('PDF nicht mehr da', { status: 404 });
}

// Ein Stueck [start, end] bei der Engine holen. Ruft onHead einmal, dann onData.
function engineFetch(client, player, start, end, handler) {
  const id = nextFetchId++;
  fetches.set(id, handler);
  client.postMessage({ bl: 'fetch', id, player, start, end });
  return {
    cancel() {
      fetches.delete(id);
      client.postMessage({ bl: 'fetch-cancel', id });
    },
    done() {
      fetches.delete(id);
    },
  };
}

function parseRange(header) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header || '');
  if (!match)
    return { start: 0, end: -1 };
  return { start: match[1] ? Number(match[1]) : 0, end: match[2] ? Number(match[2]) : -1 };
}

async function mediaResponse(event, player) {
  const client = await pageClient(event);
  if (!client)
    return new Response('keine Oberflaeche', { status: 503 });
  const range = parseRange(event.request.headers.get('Range'));
  const wantsRange = event.request.headers.has('Range');

  // Erstes Stueck holen, an der Antwort sehen wir, ob der Server Range kann
  let position = range.start;
  const firstEnd = range.end >= 0 ? Math.min(range.end, position + CHUNK - 1) : position + CHUNK - 1;
  let current = null;
  let total = -1;
  let streamController = null;
  let finished = false;
  let waitingForPull = null;

  const head = await new Promise((resolve) => {
    current = engineFetch(client, player, position, firstEnd, {
      onHead: resolve,
      onData: (bytes) => {
        position += bytes.length;
        streamController?.enqueue(bytes);
      },
      onEnd: () => chunkDone(),
      onError: (message) => {
        resolve({ status: 502, error: message });
        fail(message);
      },
    });
  });
  if (head.error)
    return new Response(head.error, { status: 502 });

  // 206 mit Content-Range: wir koennen in Stuecken weiterladen
  const rangeMatch = /bytes (\d+)-(\d+)\/(\d+|\*)/.exec(head.range || '');
  const chunked = head.status === 206 && rangeMatch;
  if (chunked && rangeMatch[3] !== '*')
    total = Number(rangeMatch[3]);
  const lastByte = range.end >= 0 ? range.end : total - 1;

  function chunkDone() {
    current?.done();
    current = null;
    if (!chunked || (total >= 0 && position > lastByte)) {
      finished = true;
      streamController?.close();
      return;
    }
    // Naechstes Stueck sofort, wenn noch Platz ist, sonst wenn der Browser liest (pull)
    if (streamController && streamController.desiredSize > 0)
      fetchNext();
    else
      waitingForPull = true;
  }

  function fail(message) {
    finished = true;
    try {
      streamController?.error(new Error(message));
    } catch {}
  }

  function fetchNext() {
    waitingForPull = null;
    const end = total >= 0 ? Math.min(lastByte, position + CHUNK - 1) : position + CHUNK - 1;
    current = engineFetch(client, player, position, end, {
      onHead: (next) => {
        if (next.status !== 206)
          fail('Range nicht mehr unterstuetzt');
      },
      onData: (bytes) => {
        position += bytes.length;
        streamController?.enqueue(bytes);
      },
      onEnd: () => chunkDone(),
      onError: fail,
    });
  }

  const body = new ReadableStream({
    start(controller) {
      streamController = controller;
      // Das erste Stueck war vielleicht schon fertig
      if (waitingForPull && controller.desiredSize > 0)
        queueMicrotask(fetchNext);
    },
    pull() {
      if (!finished && waitingForPull)
        fetchNext();
    },
    cancel() {
      finished = true;
      current?.cancel();
      current = null;
    },
  }, { highWaterMark: CHUNK, size: (chunk) => chunk.length });

  const headers = new Headers();
  headers.set('Content-Type', head.type || 'application/octet-stream');
  headers.set('Accept-Ranges', chunked ? 'bytes' : 'none');
  headers.set('Cache-Control', 'no-store');
  let status = 200;
  if (chunked && wantsRange) {
    status = 206;
    headers.set('Content-Range', `bytes ${range.start}-${lastByte}/${total >= 0 ? total : '*'}`);
    if (total >= 0)
      headers.set('Content-Length', String(lastByte - range.start + 1));
  } else if (chunked && total >= 0) {
    headers.set('Content-Length', String(total));
  } else if (head.length) {
    headers.set('Content-Length', head.length);
  }
  if (!chunked && head.status >= 400)
    status = head.status;
  return new Response(body, { status, headers });
}
