// Service Worker: liefert die Daten fuer <video>/<audio> der Seiten in der Engine.
//
// Das versteckte <video> der Oberflaeche (media.js) laedt bl-media/<player>/...
// Hier wird daraus eine Antwort, deren Daten die Engine Stueck fuer Stueck
// ueber das Relay laedt (Range-Requests). Das naechste Stueck wird erst geholt,
// wenn der Browser die Daten auch liest. So kommt ein langes Video nie ganz in
// den Speicher. Alles andere geht normal ans Netz.

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
      onEnd: () => chunkDone(range.start, firstEnd),
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
  // Letztes Byte der Antwort. Ohne bekannte Laenge (bytes a-b/*) und mit
  // offenem Range nur das erste Stueck, den Rest fragt der Browser neu an.
  let lastByte = range.end >= 0 ? range.end : Infinity;
  if (total >= 0)
    lastByte = Math.min(lastByte, total - 1);
  else if (chunked && wantsRange && range.end < 0)
    lastByte = Number(rangeMatch[2]);

  function chunkDone(start, end) {
    current?.done();
    current = null;
    // Fertig: alles da, kein Fortschritt mehr, oder ohne bekannte Laenge ein
    // kuerzeres Stueck als angefragt (Dateiende)
    if (!chunked || position > lastByte || position === start || (total < 0 && position <= end)) {
      finish();
      return;
    }
    // Naechstes Stueck sofort, wenn noch Platz ist, sonst wenn der Browser liest (pull)
    if (streamController && streamController.desiredSize > 0)
      fetchNext();
    else
      waitingForPull = true;
  }

  function finish() {
    finished = true;
    try {
      streamController?.close();
    } catch {}
  }

  function fail(message) {
    finished = true;
    try {
      streamController?.error(new Error(message));
    } catch {}
  }

  function fetchNext() {
    waitingForPull = null;
    const start = position;
    const end = Math.min(lastByte, position + CHUNK - 1);
    const request = current = engineFetch(client, player, start, end, {
      onHead: (next) => {
        if (next.status === 206)
          return;
        request.cancel();
        current = null;
        // 416 heisst: hinter dem Ende, also fertig. Ohne bekannte Laenge auch
        // jeder andere Status, sonst hat sich die Datei geaendert.
        if (next.status === 416 || total < 0)
          finish();
        else
          fail('Range nicht mehr unterstuetzt');
      },
      onData: (bytes) => {
        position += bytes.length;
        streamController?.enqueue(bytes);
      },
      onEnd: () => chunkDone(start, end),
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
