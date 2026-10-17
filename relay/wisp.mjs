// Wisp-Verbindungen des Relays (wisp-js) mit dem Grund, warum ein Stream nicht aufgeht.
//
// wisp-js schliesst jeden gescheiterten Verbindungsaufbau mit 0x03 (Netzwerkfehler). Der
// Browser zeigt aber wie Chrome, was war: Name unbekannt (0x42), abgewiesen (0x44), keine
// Antwort (0x43), gesperrt (0x48), Adresse nicht erreichbar (0x4a, nicht in Wisp: dort ist
// 0x42 beides). Darum eigene TCP-Sockets (Option TCPSocket von wisp-js), die sich den Grund
// merken, und eine Verbindung, die ihn statt 0x03 schickt.
//
// Jeder Socket prueft die Adresse, mit der er wirklich verbindet (allowAddress), so gibt es
// zwischen Pruefen und Verbinden kein DNS-Rebinding. Andere Streams als TCP gibt es nicht.
//
// Solange Streams offen sind und das Relay sonst nichts schickt, kommt alle KEEPALIVE ms ein
// CONTINUE auf Stream 0: der Client (web/transport.js) sieht so auch bei langsamem Upload,
// dass die Verbindung lebt.
import dns from 'node:dns/promises';
import net from 'node:net';
import { WebSocketServer } from 'ws';
import { server as wisp, packet } from '@mercuryworkshop/wisp-js/server';

const reasons = { ...packet.close_reasons, AddressUnreachable: 0x4a };
const QUEUE_LIMIT = 128; // wie wisp-js: so viele Stuecke puffern, dann das Lesen anhalten
const SEND_BUFFER = 32 * 1024 * 1024; // wie wisp-js: ab so viel im Puffer der WebSocket warten
const KEEPALIVE = 3000;
const CLOSE_TIMEOUT = 10000; // so lange darf das Ziel nach dem Schliessen noch lesen

function reasonFor(error) {
  // Mehrere Adressen (autoSelectFamily): AggregateError, der letzte Versuch zaehlt
  switch (error?.code ?? error?.errors?.at(-1)?.code) {
  case 'ECONNREFUSED':
    return reasons.ConnRefused;
  case 'ETIMEDOUT':
    return reasons.NoResponse;
  case 'EHOSTUNREACH':
  case 'ENETUNREACH':
    return reasons.AddressUnreachable;
  default:
    return reasons.NetworkError;
  }
}

// allowAddress(ip): darf das Relay zu dieser Adresse verbinden?
// streamsPerHost: so viele Streams einer Verbindung zum gleichen Ziel (Name und Port), weitere enden mit 0x49
export function createWispHandler({ allowAddress, streamsPerHost = Infinity }) {
  class RelaySocket {
    constructor(hostname, port) {
      this.hostname = hostname;
      this.port = port;
      this.failure = null;
      this.socket = null;
      this.connected = false;
      this.queue = [];
      this.waiting = null;
      this.throttled = false;
      this.closed = false;
    }

    async connect() {
      if (this.throttled) {
        this.failure = reasons.ConnThrottled;
        throw new Error(`zu viele Streams zu ${this.hostname}`);
      }
      let addresses = [{ address: this.hostname, family: net.isIP(this.hostname) }];
      if (!addresses[0].family) {
        try {
          addresses = await dns.lookup(this.hostname, { all: true });
        } catch (error) {
          this.failure = reasons.UnreachableHost;
          throw error;
        }
      }
      addresses = addresses.filter(({ address }) => allowAddress(address));
      if (!addresses.length) {
        this.failure = reasons.HostBlocked;
        throw new Error(`${this.hostname} ist keine oeffentliche Adresse`);
      }
      // Schliesst der Client den Stream, waehrend wisp-js prueft oder der Name aufgeloest
      // wird, ist er schon weg: eine Verbindung danach zaehlte zu keiner Grenze
      if (this.closed)
        throw new Error('Stream schon geschlossen');
      // Nur zu den geprueften Adressen, IPv6 und IPv4 abwechselnd wie ein Browser
      // (ohne IPv6 auf dem Server ginge sonst ein Name mit AAAA-Eintrag zuerst nicht)
      const socket = net.connect({
        host: this.hostname,
        port: this.port,
        noDelay: true,
        autoSelectFamily: true,
        lookup: (hostname, options, callback) => (options.all ? callback(null, addresses) : callback(null, addresses[0].address, addresses[0].family)),
      });
      this.socket = socket;
      await new Promise((resolve, reject) => {
        socket.on('connect', () => {
          this.connected = true;
          resolve();
        });
        socket.on('error', (error) => {
          if (!this.connected)
            this.failure = reasonFor(error);
        });
        socket.on('data', (data) => this.push(data));
        socket.on('close', () => {
          if (!this.connected)
            reject(new Error('Verbindung fehlgeschlagen'));
          this.socket = null;
          this.push(null);
        });
      });
    }

    // Gegendruck hier an der Quelle: haengt das Senden zum Client, waechst nichts ohne Grenze
    push(data) {
      if (this.closed && data !== null)
        return;
      const waiting = this.waiting;
      this.waiting = null;
      if (waiting)
        waiting(data);
      else
        this.queue.push(data);
      if (this.queue.length >= QUEUE_LIMIT)
        this.socket?.pause();
    }

    // Naechstes Stueck, null am Ende
    recv() {
      if (this.queue.length) {
        const data = this.queue.shift();
        if (this.queue.length < QUEUE_LIMIT && !this.closed)
          this.socket?.resume();
        return Promise.resolve(data);
      }
      return new Promise((resolve) => {
        this.waiting = resolve;
      });
    }

    send(data) {
      return new Promise((resolve) => {
        if (this.socket)
          this.socket.write(data, () => resolve());
        else
          resolve();
      });
    }

    // Der Client liest den Stream nicht mehr: was er geschickt hat, geht noch zum Ziel, dann
    // ist der Socket ganz zu. Ankommendes faellt weg, tcp_to_ws von wisp-js endet.
    close() {
      if (this.closed)
        return;
      this.closed = true;
      this.queue = [];
      this.push(null);
      const socket = this.socket;
      if (!socket)
        return;
      if (!this.connected) {
        socket.destroy();
        return;
      }
      socket.end(() => socket.destroy());
      setTimeout(() => socket.destroy(), CLOSE_TIMEOUT).unref();
    }

    // wisp-js haelt das Lesen um jedes Senden zum Client an, das macht schon push
    pause() {}
    resume() {}
  }

  class NoSocket {
    constructor(hostname, port) {
      this.hostname = hostname;
      this.port = port;
      this.failure = reasons.HostBlocked;
    }

    async connect() {
      throw new Error('nur TCP');
    }

    close() {}
  }

  class RelayConnection extends wisp.ServerConnection {
    constructor(ws, path, options) {
      super(ws, path, options);
      this.lastSend = Date.now();
      // Wie AsyncWebSocket.send von wisp-js, aber ohne Warten nach dem Schliessen: dann leert
      // sich der Puffer nie und jeder Stream wartete fuer immer
      this.ws.send = async (data) => {
        if (ws.readyState !== ws.OPEN)
          return;
        ws.send(data instanceof packet.WispPacket ? data.serialize().bytes : data);
        this.lastSend = Date.now();
        if (ws.bufferedAmount <= SEND_BUFFER)
          return;
        while (ws.readyState === ws.OPEN && ws.bufferedAmount > SEND_BUFFER / 2)
          await new Promise((resolve) => setTimeout(resolve, 10));
      };
    }

    async setup() {
      await super.setup();
      this.keepalive = setInterval(() => {
        if (Date.now() - this.lastSend < KEEPALIVE || !Object.keys(this.streams).length)
          return;
        this.ws.send(new packet.WispPacket({
          type: packet.ContinuePayload.type,
          stream_id: 0,
          payload: new packet.ContinuePayload({ buffer_remaining: wisp.ServerStream.buffer_size }),
        }));
      }, KEEPALIVE / 3);
    }

    refuse(streamId, reason) {
      this.ws.send(new packet.WispPacket({
        type: packet.ClosePayload.type,
        stream_id: streamId,
        payload: new packet.ClosePayload({ reason }),
      }));
    }

    // Grenze pro Ziel selber: stream_limit_per_host von wisp-js geht ueber this.streams wie
    // ueber eine Liste, es ist aber ein Objekt ("is not iterable", auch in 0.5.0). wisp-js
    // legt den Socket hier an und verbindet erst nach seiner asynchronen Pruefung. Ziel ist wie
    // in Chrome Name und Port, "Example.org." zaehlt wie "example.org".
    create_stream(streamId, type, hostname, port) {
      // Ohne Ziel (leer oder Port 0) gibt es nichts zu verbinden: sofort 0x41, vor den Filtern
      // von wisp-js und ohne Log. So fragt der Client nach, ob die Verbindung lebt (web/transport.js).
      if (!hostname || !port) {
        this.refuse(streamId, reasons.InvalidInfo);
        return;
      }
      // Den Filter von wisp-js fuer UDP umginge jeder andere Typ, und dessen Socket prueft
      // die Adresse nicht (allowAddress)
      if (type !== packet.stream_types.TCP) {
        this.refuse(streamId, reasons.HostBlocked);
        return;
      }
      const target = (name, port) => `${name.toLowerCase().replace(/\.$/, '')}:${port}`;
      const key = target(hostname, port);
      const open = Object.values(this.streams).filter(({ socket }) => target(socket.hostname, socket.port) === key).length;
      super.create_stream(streamId, type, hostname, port);
      if (open >= streamsPerHost)
        this.streams[streamId].socket.throttled = true;
    }

    async close_stream(streamId, reason = null, quiet = false) {
      const failure = this.streams[streamId]?.socket.failure;
      return super.close_stream(streamId, reason === reasons.NetworkError && failure ? failure : reason, quiet);
    }
  }

  const sockets = new WebSocketServer({ noServer: true });
  return (req, socket, head) => sockets.handleUpgrade(req, socket, head, async (ws) => {
    ws.binaryType = 'arraybuffer';
    // Der Client (web/transport.js) spricht Wisp v1
    const connection = new RelayConnection(ws, '/wisp/', { TCPSocket: RelaySocket, UDPSocket: NoSocket, wisp_version: 1 });
    try {
      await connection.setup();
      await connection.run();
    } catch {
      ws.close();
    } finally {
      clearInterval(connection.keepalive);
    }
  });
}
