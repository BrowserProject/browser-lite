// Netzwerk-Transport der Engine.
//
// Die Engine (libcurl + OpenSSL im WASM) benutzt Emscriptens SOCKFS. SOCKFS baut
// fuer jede TCP-Verbindung ein "new WebSocket('ws://host:port/')". Wir ersetzen
// WebSocket durch TransportSocket: der oeffnet stattdessen einen TCP-Stream
// ueber den aktiven Transport. TLS passiert im WASM, der Transport sieht nur
// verschluesselte Bytes.
//
// Transport-Schnittstelle (damit spaeter WireGuard die gleiche Stelle nutzt):
//   transport.openTCP(host, port) -> stream
//   stream.send(Uint8Array), stream.close()
//   stream.onopen(), stream.ondata(Uint8Array), stream.onclose(reason)

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

export class WispTransport {
  constructor(url) {
    this.url = url;
    this.streams = new Map();
    this.nextStreamId = 1;
    this.bufferSize = 0;
    this.ready = null;
    this.ws = null;
  }

  connect() {
    if (this.ready)
      return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const ws = new NativeWebSocket(this.url);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      let opened = false;
      ws.onopen = () => {
        opened = true;
      };
      ws.onmessage = (event) => {
        const packet = new Uint8Array(event.data);
        // Das erste CONTINUE auf Stream 0 sagt uns die Puffergroesse
        if (!this.bufferSize && packet[0] === CONTINUE) {
          this.bufferSize = new DataView(packet.buffer).getUint32(5, true);
          resolve();
          return;
        }
        this.handlePacket(packet);
      };
      let closed = false;
      const onClosed = () => {
        if (closed)
          return;
        closed = true;
        if (this.ws === ws)
          this.ready = null;
        for (const stream of this.streams.values())
          stream.closed(0x03); // Netzwerkfehler
        this.streams.clear();
        if (!opened)
          reject(new Error('Wisp-Verbindung fehlgeschlagen: ' + this.url));
      };
      ws.onclose = onClosed;
      // Node (undici) schickt bei abgelehntem Handshake nur error, kein close
      ws.onerror = () => {
        if (!opened)
          onClosed();
      };
    });
    return this.ready;
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
    while (this.isOpen && this.queue.length && this.credit > 0) {
      this.transport.sendPacket(DATA, this.id, this.queue.shift());
      this.credit--;
    }
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

// ---------------------------------------------- WebSocket-Ersatz fuer SOCKFS

let activeTransport = null;

export function setTransport(transport) {
  activeTransport = transport;
}

export class TransportSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url) {
    super();
    // Konstanten auch auf der Instanz (SOCKFS prueft socket.CLOSED usw.)
    this.CONNECTING = 0;
    this.OPEN = 1;
    this.CLOSING = 2;
    this.CLOSED = 3;
    this.url = url;
    this.binaryType = 'arraybuffer';
    this.readyState = 0;
    this.bufferedAmount = 0;
    this.protocol = '';
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;

    const match = /^wss?:\/\/\[?([^\]/]+?)\]?:(\d+)/.exec(url);
    if (!match || !activeTransport) {
      queueMicrotask(() => this.fail());
      return;
    }
    this.stream = activeTransport.openTCP(match[1], Number(match[2]));
    this.stream.onopen = () => {
      this.readyState = 1;
      this.emit('open', new Event('open'));
    };
    this.stream.ondata = (data) => {
      this.emit('message', new MessageEvent('message', { data: data.buffer }));
    };
    this.stream.onclose = (reason) => {
      const wasOpen = this.readyState === 1;
      this.readyState = 3;
      if (!wasOpen)
        this.emit('error', new Event('error'));
      this.emit('close', new CloseEvent('close', { code: reason === CLOSE_VOLUNTARY ? 1000 : 1006 }));
    };
  }

  emit(type, event) {
    this['on' + type]?.(event);
    this.dispatchEvent(event);
  }

  fail() {
    this.readyState = 3;
    this.emit('error', new Event('error'));
    this.emit('close', new CloseEvent('close', { code: 1006 }));
  }

  send(data) {
    if (this.readyState !== 1)
      return;
    this.stream.send(ArrayBuffer.isView(data) ? data : new Uint8Array(data));
  }

  close() {
    if (this.readyState >= 2)
      return;
    this.readyState = 2;
    this.stream?.close();
  }
}

// SOCKFS benutzt das globale WebSocket. Unsere eigene UI braucht kein WebSocket,
// der Transport hat sich das Original oben schon gemerkt.
export function installTransportSocket() {
  globalThis.WebSocket = TransportSocket;
}
