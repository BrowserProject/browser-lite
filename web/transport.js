// Netzwerk-Transport der Engine.
//
// Die Engine (libcurl + OpenSSL im WASM) hat eigene Sockets
// (engine/src/Sockets.cpp). Jede TCP-Verbindung wird ein Stream ueber den
// Transport (Module.blTransport, engine/js/sockets.js). TLS passiert im WASM,
// der Transport sieht nur verschluesselte Bytes.
//
// Transport-Schnittstelle (damit spaeter WireGuard die gleiche Stelle nutzt):
//   transport.openTCP(host, port) -> stream
//   stream.send(Uint8Array), stream.close()
//   stream.onopen(), stream.ondata(Uint8Array), stream.onclose(reason)
//   stream.onsent(bytes): so viele Bytes aus send() haben den Puffer des
//   Transports verlassen (Gegendruck fuer die Sockets der Engine)
//   transport.connected, transport.onconnectedchange(connected): steht die
//   Verbindung (navigator.onLine der Seiten)? Mit onconnectedchange baut der
//   Transport eine verlorene Verbindung selber wieder auf, sonst erst beim
//   naechsten openTCP.
// onclose bekommt den Grund von Wisp. Erreicht der Transport sein Relay nicht,
// schliesst er den Stream vor onopen (die Engine meldet dann "kein Relay").

const NativeWebSocket = globalThis.WebSocket;

// ------------------------------------------------------------- Wisp (v1)
// Spezifikation: https://github.com/MercuryWorkshop/wisp-protocol
// Paket: Typ (u8) | Stream-ID (u32 LE) | Inhalt

const CONNECT = 0x01;
const DATA = 0x02;
const CONTINUE = 0x03;
const CLOSE = 0x04;
const STREAM_TCP = 0x01;

const CLOSE_VOLUNTARY = 0x02;
const HANDSHAKE_TIMEOUT = 15000;
const RECONNECT_DELAY = 2000;
const SILENCE = 10000;
const PROBE_TIMEOUT = 5000;

export class WispTransport {
  constructor(url) {
    this.url = url;
    this.streams = new Map();
    this.nextStreamId = 1;
    this.bufferSize = 0;
    this.ready = null;
    this.ws = null;
    this.connected = true;
    this.onconnectedchange = null;
    this.reconnectTimer = null;
    this.lastDrop = 0;
    // Lebt die Verbindung noch? (expectAnswer)
    this.received = 0;
    this.sent = 0;
    this.watchdog = null;
    this.probeTimer = null;
    this.drop = null;
    // Nach einem Netzwechsel ist die alte Verbindung oft tot, ohne dass sie zugeht
    globalThis.addEventListener?.('online', () => this.probe());
  }

  // Jeder WebSocket hat seinen eigenen Handshake. Geht er zu, baut das
  // naechste openTCP einen neuen auf (z.B. nach einem Neustart des Relays).
  connect() {
    if (this.ready)
      return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const ws = new NativeWebSocket(this.url);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      this.sent = 0;
      let handshake = false;
      let closed = false;
      const onClosed = () => {
        if (closed)
          return;
        closed = true;
        clearTimeout(timeout);
        if (this.ws === ws) {
          this.ready = null;
          this.drop = null;
          clearTimeout(this.watchdog);
          clearTimeout(this.probeTimer);
          this.watchdog = this.probeTimer = null;
        }
        for (const stream of this.streams.values())
          stream.closed(0x03); // Netzwerkfehler
        this.streams.clear();
        if (!handshake)
          reject(new Error('Wisp-Verbindung fehlgeschlagen: ' + this.url));
        // Bricht eine stehende Verbindung ab (z.B. schliesst ein Proxy sie im
        // Leerlauf), gleich einmal neu verbinden: offline erst, wenn das scheitert
        if (handshake && this.onconnectedchange && Date.now() - this.lastDrop > RECONNECT_DELAY) {
          this.lastDrop = Date.now();
          this.connect().catch(() => {});
        } else
          this.setConnected(false);
      };
      // Sofort aufgeben, ohne auf das Schliessen der WebSocket zu warten
      const drop = () => {
        onClosed();
        ws.close();
      };
      // Antwortet etwas ohne Wisp (z.B. ein Proxy), nicht ewig warten
      const timeout = setTimeout(drop, HANDSHAKE_TIMEOUT);
      ws.onmessage = (event) => {
        if (closed)
          return;
        const packet = new Uint8Array(event.data);
        if (handshake) {
          this.received++;
          clearTimeout(this.probeTimer);
          this.probeTimer = null;
          this.handlePacket(packet);
          return;
        }
        // Das erste CONTINUE auf Stream 0 sagt uns die Puffergroesse
        const view = new DataView(packet.buffer);
        if (packet.length >= 9 && packet[0] === CONTINUE && view.getUint32(1, true) === 0) {
          handshake = true;
          clearTimeout(timeout);
          this.bufferSize = view.getUint32(5, true);
          this.drop = drop;
          resolve();
          this.setConnected(true);
        }
      };
      ws.onclose = onClosed;
      // Node (undici) schickt bei abgelehntem Handshake nur error, kein close
      ws.onerror = onClosed;
    });
    return this.ready;
  }

  setConnected(connected) {
    if (!connected && this.onconnectedchange && !this.reconnectTimer) {
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connect().catch(() => {});
      }, RECONNECT_DELAY);
    }
    if (connected === this.connected)
      return;
    this.connected = connected;
    this.onconnectedchange?.(connected);
  }

  openTCP(host, port) {
    const stream = new WispStream(this, this.nextStreamId++, host, port);
    this.streams.set(stream.id, stream);
    this.connect().then(() => stream.start(), () => stream.closed(0x03));
    return stream;
  }

  sendPacket(type, streamId, payload) {
    const packet = new Uint8Array(5 + payload.byteLength);
    const view = new DataView(packet.buffer);
    packet[0] = type;
    view.setUint32(1, streamId, true);
    packet.set(payload, 5);
    this.ws.send(packet);
    this.sent += packet.byteLength;
    if (type !== CLOSE)
      this.expectAnswer();
  }

  // Wisp hat kein Ping. Kommt nach dem Senden 10 s gar nichts zurueck (halb offene
  // Verbindung, z.B. nach dem Ruhezustand), fragt der Transport nach: ein CONNECT auf
  // ein leeres Ziel muss das Relay laut Spezifikation sofort mit CLOSE beantworten.
  // Bleibt auch das aus, ist die Verbindung tot: zu (die Streams enden mit 0x03), neu verbinden.
  // Die Nachfrage stuende hinter allem, was noch im Puffer der WebSocket liegt (langsamer
  // Upload): solange er abfliesst, lebt die Verbindung, gefragt wird erst, wenn er leer ist.
// Was schon im Puffer des Betriebssystems liegt, sieht die Seite nicht: dafuer meldet sich
// unser Relay bei offenen Streams spaetestens alle 3 s (relay/wisp.mjs), die Stille kommt so nur
// bei toter Verbindung oder einem Relay ohne dieses Lebenszeichen.
  expectAnswer() {
    if (this.watchdog || this.probeTimer)
      return;
    const received = this.received;
    const drained = this.drained();
    this.watchdog = setTimeout(() => {
      this.watchdog = null;
      if (this.received === received)
        this.probe(drained);
    }, SILENCE);
  }

  // So viele Bytes hat die WebSocket schon ans Netz gegeben
  drained() {
    return this.sent - (this.ws?.bufferedAmount ?? 0);
  }

  // drained: Stand vor der Stille (expectAnswer)
  probe(drained = -1) {
    if (this.probeTimer || !this.drop || this.ws?.readyState !== NativeWebSocket.OPEN)
      return;
    if (this.ws.bufferedAmount > 0) {
      if (this.drained() > drained)
        this.expectAnswer();
      else
        this.drop(); // 10 s ist nichts abgeflossen
      return;
    }
    this.probeTimer = setTimeout(this.drop, PROBE_TIMEOUT);
    this.sendPacket(CONNECT, this.nextStreamId++, new Uint8Array([STREAM_TCP, 0, 0]));
  }

  handlePacket(packet) {
    const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
    const type = packet[0];
    const stream = this.streams.get(view.getUint32(1, true));
    if (!stream)
      return;
    switch (type) {
    case DATA:
      stream.received(packet.subarray(5));
      break;
    case CONTINUE:
      stream.credit = view.getUint32(5, true);
      stream.flush();
      break;
    case CLOSE:
      this.streams.delete(stream.id);
      stream.closed(packet[5]);
      break;
    default:
      // INFO (Wisp v2) und Unbekanntes ignorieren
      break;
    }
  }
}

class WispStream {
  constructor(transport, id, host, port) {
    this.transport = transport;
    this.id = id;
    this.host = host;
    this.port = port;
    this.credit = 0;
    this.queue = [];
    this.isOpen = false;
    this.isClosed = false;
    this.onopen = null;
    this.ondata = null;
    this.onsent = null;
    this.onclose = null;
  }

  start() {
    if (this.isClosed)
      return;
    const host = new TextEncoder().encode(this.host);
    const payload = new Uint8Array(3 + host.length);
    payload[0] = STREAM_TCP;
    new DataView(payload.buffer).setUint16(1, this.port, true);
    payload.set(host, 3);
    this.transport.sendPacket(CONNECT, this.id, payload);
    this.credit = this.transport.bufferSize;
    this.isOpen = true;
    this.onopen?.();
    this.flush();
  }

  send(data) {
    if (this.isClosed)
      return;
    this.queue.push(new Uint8Array(data));
    this.flush();
  }

  // Flusskontrolle: nur so viele Pakete senden, wie der Server erlaubt
  flush() {
    let sent = 0;
    while (this.isOpen && this.queue.length && this.credit > 0) {
      const data = this.queue.shift();
      this.transport.sendPacket(DATA, this.id, data);
      this.credit--;
      sent += data.byteLength;
    }
    if (sent)
      this.onsent?.(sent);
  }

  received(data) {
    this.ondata?.(data.slice());
  }

  close() {
    if (this.isClosed)
      return;
    if (this.isOpen && this.transport.ws?.readyState === NativeWebSocket.OPEN)
      this.transport.sendPacket(CLOSE, this.id, new Uint8Array([CLOSE_VOLUNTARY]));
    this.transport.streams.delete(this.id);
    this.closed(CLOSE_VOLUNTARY);
  }

  closed(reason) {
    if (this.isClosed)
      return;
    this.isClosed = true;
    this.isOpen = false;
    this.onclose?.(reason);
  }
}
