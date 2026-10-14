#include "config.h"
#include "WebPlatformExtras.h"

namespace BrowserLite {

// WebRTC der Seiten ueber das RTCPeerConnection des Host-Browsers (web/webrtc.js).
//
// Laeuft vor dem allgemeinen Polyfill (das loescht die Bruecke). Jede
// Verbindung und jeder Kanal hat im Host ein echtes Gegenstueck; die Seite
// bekommt Objekte mit der API von Chrome. Zustand (Beschreibungen, Status)
// spiegeln wir hier, damit die Eigenschaften synchron lesbar sind. Ereignisse
// holt eine Schleife mit "rtc-poll" (der Host antwortet, sobald etwas da ist).
const char* const webrtcPolyfillSource = R"JS((() => {
  const host = globalThis.__blHost;
  // Spuren der Seite <-> Host (engine/src/media/MediaStreamWasm.cpp)
  const media = globalThis.__blMedia;
  delete globalThis.__blMedia;
  if (typeof host !== 'function' || 'RTCPeerConnection' in globalThis)
    return;
  const define = (target, name, value) => Object.defineProperty(target, name, { value, writable: true, configurable: true, enumerable: false });
  const call = (name, payload) => new Promise((resolve, reject) => {
    host(name, JSON.stringify(payload ?? null), (ok, result) => {
      const value = JSON.parse(result);
      if (ok)
        resolve(value);
      else
        reject(new DOMException(value?.message || 'Failed', value?.name || 'OperationError'));
    });
  });
  // randomUUID gibt es nur auf sicheren Seiten
  const client = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  let nextId = 0;
  const connections = new Map(); // id -> RTCPeerConnection
  const channels = new Map(); // key -> RTCDataChannel
  const internal = new WeakMap();
  const state = (object) => internal.get(object);

  const toBase64 = (bytes) => {
    if (typeof bytes.toBase64 === 'function')
      return bytes.toBase64();
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000)
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  };
  const fromBase64 = (text) => typeof Uint8Array.fromBase64 === 'function' ? Uint8Array.fromBase64(text) : Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

  // ---------------------------------------------------------------- Ereignisse
  let polling = false;
  function poll() {
    if (polling)
      return;
    polling = true;
    (async () => {
      while (connections.size) {
        let events;
        try {
          events = await call('rtc-poll', { client });
        } catch (e) {
          break;
        }
        for (const event of events) {
          try {
            dispatchHostEvent(event);
          } catch (e) {
            reportError(e);
          }
        }
      }
      polling = false;
    })();
  }
  addEventListener('pagehide', () => {
    if (connections.size)
      call('rtc-close-all', { client }).catch(() => {});
  });

  function dispatchHostEvent(event) {
    if (event.channel !== undefined) {
      const channel = channels.get(event.channel);
      if (channel)
        state(channel).hostEvent(event);
      return;
    }
    const connection = connections.get(event.pc);
    if (connection)
      state(connection).hostEvent(event);
  }

  // ---------------------------------------------------------------- Beschreibungen
  class RTCSessionDescription {
    constructor(init = {}) {
      this.type = init.type ?? '';
      this.sdp = init.sdp ?? '';
    }
    toJSON() { return { type: this.type, sdp: this.sdp }; }
  }
  const description = (value) => value ? new RTCSessionDescription(value) : null;

  const candidateFields = (candidate) => {
    const match = /^(?:a=)?candidate:(\S+) (\d+) (\S+) (\d+) (\S+) (\d+) typ (\S+)(.*)$/.exec(candidate || '');
    if (!match)
      return {};
    const extra = match[8];
    const value = (key) => (new RegExp(' ' + key + ' (\\S+)').exec(extra) || [])[1] ?? null;
    return {
      foundation: match[1], component: match[2] === '1' ? 'rtp' : 'rtcp', protocol: match[3].toLowerCase(), priority: Number(match[4]),
      address: match[5], port: Number(match[6]), type: match[7], tcpType: value('tcptype'), relatedAddress: value('raddr'),
      relatedPort: value('rport') === null ? null : Number(value('rport')), usernameFragment: value('ufrag'),
    };
  };
  class RTCIceCandidate {
    constructor(init = {}) {
      if (init.sdpMid == null && init.sdpMLineIndex == null)
        throw new TypeError("Failed to construct 'RTCIceCandidate': sdpMid and sdpMLineIndex are both null.");
      this.candidate = init.candidate ?? '';
      this.sdpMid = init.sdpMid ?? null;
      this.sdpMLineIndex = init.sdpMLineIndex ?? null;
      const fields = candidateFields(this.candidate);
      for (const name of ['foundation', 'component', 'priority', 'address', 'protocol', 'port', 'type', 'tcpType', 'relatedAddress', 'relatedPort'])
        this[name] = fields[name] ?? null;
      this.usernameFragment = init.usernameFragment ?? fields.usernameFragment ?? null;
    }
    toJSON() { return { candidate: this.candidate, sdpMid: this.sdpMid, sdpMLineIndex: this.sdpMLineIndex, usernameFragment: this.usernameFragment }; }
  }

  // ---------------------------------------------------------------- Ereignis-Klassen
  class RTCPeerConnectionIceEvent extends Event {
    constructor(type, init = {}) {
      super(type, init);
      this.candidate = init.candidate ?? null;
      this.url = init.url ?? null;
    }
  }
  class RTCPeerConnectionIceErrorEvent extends Event {
    constructor(type, init = {}) {
      super(type, init);
      for (const name of ['address', 'port', 'url', 'errorCode', 'errorText'])
        this[name] = init[name] ?? null;
    }
  }
  class RTCDataChannelEvent extends Event {
    constructor(type, init = {}) {
      super(type, init);
      this.channel = init.channel;
    }
  }
  class RTCError extends DOMException {
    constructor(init = {}, message = '') {
      super(message, 'OperationError');
      this.errorDetail = init.errorDetail ?? 'data-channel-failure';
      for (const name of ['sdpLineNumber', 'sctpCauseCode', 'receivedAlert', 'sentAlert', 'httpRequestStatusCode'])
        this[name] = init[name] ?? null;
    }
  }
  class RTCErrorEvent extends Event {
    constructor(type, init = {}) {
      super(type, init);
      this.error = init.error;
    }
  }

  const eventHandlers = (prototype, names) => {
    for (const name of names) {
      const key = Symbol(name);
      Object.defineProperty(prototype, 'on' + name, {
        get() { return this[key] ?? null; },
        set(handler) {
          if (this[key])
            this.removeEventListener(name, this[key]);
          this[key] = typeof handler === 'function' ? handler : null;
          if (this[key])
            this.addEventListener(name, this[key]);
        },
        configurable: true,
        enumerable: true,
      });
    }
  };

  // ---------------------------------------------------------------- RTCDataChannel
  class RTCDataChannel extends EventTarget {
    constructor() {
      throw new TypeError('Illegal constructor');
    }
    get label() { return state(this).label; }
    get ordered() { return state(this).ordered; }
    get maxPacketLifeTime() { return state(this).maxPacketLifeTime; }
    get maxRetransmits() { return state(this).maxRetransmits; }
    get protocol() { return state(this).protocol; }
    get negotiated() { return state(this).negotiated; }
    get id() { return state(this).id; }
    get readyState() { return state(this).readyState; }
    get bufferedAmount() { return state(this).bufferedAmount; }
    get bufferedAmountLowThreshold() { return state(this).threshold; }
    set bufferedAmountLowThreshold(value) {
      const data = state(this);
      data.threshold = Math.max(0, Number(value) >>> 0);
      data.ready.then(() => call('rtc-channel', { client, channel: data.key, threshold: data.threshold })).catch(() => {});
    }
    get binaryType() { return state(this).binaryType; }
    set binaryType(value) {
      if (value === 'blob' || value === 'arraybuffer')
        state(this).binaryType = value;
    }
    send(data) {
      const channel = state(this);
      if (channel.readyState !== 'open')
        throw new DOMException("Failed to execute 'send' on 'RTCDataChannel': RTCDataChannel.readyState is not 'open'", 'InvalidStateError');
      let size;
      let payload;
      if (typeof data === 'string') {
        payload = Promise.resolve({ text: data });
        size = new TextEncoder().encode(data).length;
      } else if (data instanceof Blob) {
        size = data.size;
        payload = data.arrayBuffer().then((buffer) => ({ binary: toBase64(new Uint8Array(buffer)) }));
      } else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
        const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        size = bytes.length;
        payload = Promise.resolve({ binary: toBase64(bytes) });
      } else {
        payload = Promise.resolve({ text: String(data) });
        size = String(data).length;
      }
      channel.bufferedAmount += size;
      // In der Reihenfolge der Aufrufe senden (Blobs werden erst gelesen)
      channel.sending = channel.sending.then(() => payload).then((message) => call('rtc-send', { client, channel: channel.key, ...message })).then((result) => {
        channel.bufferedAmount = Math.max(0, channel.bufferedAmount - size);
        if (result && typeof result.bufferedAmount === 'number')
          channel.hostBuffered = result.bufferedAmount;
      }, () => {});
    }
    close() {
      const channel = state(this);
      if (channel.readyState === 'closing' || channel.readyState === 'closed')
        return;
      channel.readyState = 'closing';
      channel.sending.then(() => call('rtc-channel-close', { client, channel: channel.key })).catch(() => {});
    }
  }
  eventHandlers(RTCDataChannel.prototype, ['open', 'message', 'bufferedamountlow', 'error', 'closing', 'close']);

  function makeChannel(connection, info) {
    // EventTarget mit dem Prototyp von RTCDataChannel, ohne dessen Konstruktor
    const channel = Reflect.construct(EventTarget, [], RTCDataChannel);
    const data = {
      key: info.key, label: info.label ?? '', ordered: info.ordered ?? true, maxPacketLifeTime: info.maxPacketLifeTime ?? null,
      maxRetransmits: info.maxRetransmits ?? null, protocol: info.protocol ?? '', negotiated: info.negotiated ?? false,
      id: info.id ?? null, readyState: info.readyState ?? 'connecting', bufferedAmount: 0, hostBuffered: 0, threshold: 0,
      binaryType: 'arraybuffer', sending: Promise.resolve(), ready: Promise.resolve(), connection,
      hostEvent(event) {
        if (event.id !== undefined)
          data.id = event.id;
        switch (event.type) {
        case 'open':
          data.readyState = 'open';
          channel.dispatchEvent(new Event('open'));
          break;
        case 'message': {
          let value = event.text;
          if (event.binary !== undefined) {
            const bytes = fromBase64(event.binary);
            value = data.binaryType === 'blob' ? new Blob([bytes]) : bytes.buffer;
          }
          channel.dispatchEvent(new MessageEvent('message', { data: value, origin: '' }));
          break;
        }
        case 'bufferedamountlow':
          channel.dispatchEvent(new Event('bufferedamountlow'));
          break;
        case 'error':
          channel.dispatchEvent(new RTCErrorEvent('error', { error: new RTCError({ errorDetail: event.errorDetail || 'data-channel-failure' }, event.message || '') }));
          break;
        case 'closing':
          data.readyState = 'closing';
          channel.dispatchEvent(new Event('closing'));
          break;
        case 'close':
          data.readyState = 'closed';
          channels.delete(data.key);
          channel.dispatchEvent(new Event('close'));
          break;
        }
      },
    };
    internal.set(channel, data);
    channels.set(data.key, channel);
    return channel;
  }


  // ---------------------------------------------------------------- Medien
  // Spur der Seite fuer den Host: Kamera/Mikrofon als echte Host-Spur, alles
  // andere (Canvas, Web Audio, entfernte Spuren) ueber eine Senke der Engine
  const trackSinks = new WeakMap();
  const sentTracks = new Map(); // id -> MediaStreamTrack
  function describeTrack(track) {
    if (track === null || track === undefined)
      return null;
    if (typeof MediaStreamTrack !== 'function' || !(track instanceof MediaStreamTrack))
      throw new TypeError("The provided value is not of type 'MediaStreamTrack'.");
    const info = { id: track.id, kind: track.kind, enabled: track.enabled };
    const capture = media ? media('capture', track) : 0;
    if (capture)
      info.capture = capture;
    else if (media) {
      let sink = trackSinks.get(track);
      if (!sink) {
        sink = media('sink', track);
        trackSinks.set(track, sink);
      }
      info.sink = sink;
    }
    sentTracks.set(track.id, track);
    return info;
  }
  if (typeof MediaStreamTrack === 'function') {
    // enabled = false sendet wie in Chrome schwarze Bilder/Stille, stop() beendet
    const enabled = Object.getOwnPropertyDescriptor(MediaStreamTrack.prototype, 'enabled');
    if (enabled?.set) {
      Object.defineProperty(MediaStreamTrack.prototype, 'enabled', {
        ...enabled,
        set(value) {
          enabled.set.call(this, value);
          if (sentTracks.get(this.id) === this)
            call('rtc-track', { client, track: this.id, enabled: !!value }).catch(() => {});
        },
      });
    }
    const originalStop = MediaStreamTrack.prototype.stop;
    define(MediaStreamTrack.prototype, 'stop', function stop() {
      originalStop.call(this);
      if (sentTracks.get(this.id) === this) {
        sentTracks.delete(this.id);
        const sink = trackSinks.get(this);
        if (sink && media)
          media('sink-stop', sink);
        call('rtc-track', { client, track: this.id, stop: true }).catch(() => {});
      }
    });
  }

  // Fallback, bis der Host seine Liste geschickt hat
  let capabilities = {
    sender: {
      audio: { codecs: [{ mimeType: 'audio/opus', clockRate: 48000, channels: 2, sdpFmtpLine: 'minptime=10;useinbandfec=1' }], headerExtensions: [] },
      video: { codecs: [{ mimeType: 'video/VP8', clockRate: 90000 }, { mimeType: 'video/VP9', clockRate: 90000 }, { mimeType: 'video/AV1', clockRate: 90000 }, { mimeType: 'video/H264', clockRate: 90000 }], headerExtensions: [] },
    },
  };
  capabilities.receiver = capabilities.sender;
  const copy = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

  class RTCRtpSender {
    constructor() {
      throw new TypeError('Illegal constructor');
    }
    get track() { return state(this).track; }
    get transport() { return null; }
    get rtcpTransport() { return null; }
    get dtmf() { return null; }
    getParameters() { return copy(state(this).parameters) ?? { transactionId: '', encodings: [], codecs: [], headerExtensions: [], rtcp: {} }; }
    setParameters(parameters) {
      const data = state(this);
      return data.pc._operation('setParameters', { transceiver: data.key, parameters: copy(parameters) }).then(() => undefined);
    }
    replaceTrack(track) {
      const data = state(this);
      let info;
      try {
        info = describeTrack(track ?? null);
      } catch (e) {
        return Promise.reject(e);
      }
      if (track && track.kind !== data.kind)
        return Promise.reject(new TypeError('The track kind does not match the sender kind.'));
      return data.pc._operation('replaceTrack', { transceiver: data.key, track: info }).then(() => {
        data.track = track ?? null;
      });
    }
    setStreams(...streams) {
      const data = state(this);
      data.pc._operation('setStreams', { transceiver: data.key, streams: streams.map((stream) => stream.id) }).catch(() => {});
    }
    getStats() { return state(this).pc._stats({ sender: state(this).key }); }
    static getCapabilities(kind) { return copy(capabilities.sender[kind]) ?? null; }
  }

  class RTCRtpReceiver {
    constructor() {
      throw new TypeError('Illegal constructor');
    }
    get track() { return receiverTrack(this); }
    get transport() { return null; }
    get rtcpTransport() { return null; }
    get jitterBufferTarget() { return null; }
    set jitterBufferTarget(value) {}
    getParameters() { return copy(state(this).parameters) ?? { codecs: [], headerExtensions: [], rtcp: {} }; }
    getStats() { return state(this).pc._stats({ receiver: state(this).key }); }
    getContributingSources() { return []; }
    getSynchronizationSources() { return []; }
    static getCapabilities(kind) { return copy(capabilities.receiver[kind]) ?? null; }
  }

  // Die Spur eines Empfaengers gibt es sofort (stumm, bis Daten kommen); die
  // Bilder/den Ton holt die Engine erst, wenn die Seite die Spur anschaut
  function receiverTrack(receiver) {
    const data = state(receiver);
    if (!data.track && media) {
      const result = media('remote', data.kind, data.kind === 'audio' ? 'remote audio' : 'remote video');
      if (result) {
        data.track = result[0];
        const pc = state(data.pc);
        if (!pc.closed)
          call('rtc-receive', { client, pc: pc.id, transceiver: data.key, source: result[1] }).catch(() => {});
      }
    }
    return data.track ?? null;
  }

  const DIRECTIONS = ['sendrecv', 'sendonly', 'recvonly', 'inactive'];
  class RTCRtpTransceiver {
    constructor() {
      throw new TypeError('Illegal constructor');
    }
    get mid() { return state(this).mid; }
    get sender() { return state(this).sender; }
    get receiver() { return state(this).receiver; }
    get direction() { return state(this).direction; }
    set direction(value) {
      const data = state(this);
      if (!DIRECTIONS.includes(value))
        throw new TypeError(`The provided value '${value}' is not a valid enum value of type RTCRtpTransceiverDirection.`);
      if (data.direction === 'stopped')
        throw new DOMException('The transceiver is stopped.', 'InvalidStateError');
      data.direction = value;
      data.pc._operation('setDirection', { transceiver: data.key, direction: value }).catch(() => {});
    }
    get currentDirection() { return state(this).currentDirection; }
    stop() {
      const data = state(this);
      if (data.direction === 'stopped')
        return;
      data.direction = 'stopped';
      data.pc._operation('stopTransceiver', { transceiver: data.key }).catch(() => {});
    }
    setCodecPreferences(codecs) {
      const data = state(this);
      data.pc._operation('setCodecPreferences', { transceiver: data.key, codecs: copy([...(codecs || [])]) }).catch(() => {});
    }
  }

  function makeTransceiver(pc, info) {
    const pcData = state(pc);
    const transceiver = Object.create(RTCRtpTransceiver.prototype);
    const sender = Object.create(RTCRtpSender.prototype);
    const receiver = Object.create(RTCRtpReceiver.prototype);
    const data = {
      key: info.key, kind: info.kind, mid: info.mid ?? null, direction: info.direction ?? 'sendrecv', currentDirection: info.currentDirection ?? null,
      sender, receiver, fresh: !info.remoteCreated, remoteCreated: !!info.remoteCreated, everSending: false, pc,
    };
    internal.set(transceiver, data);
    internal.set(sender, { key: info.key, kind: info.kind, track: null, parameters: info.sender, pc, transceiver });
    internal.set(receiver, { key: info.key, kind: info.kind, track: null, parameters: info.receiver, pc, transceiver });
    pcData.transceivers.set(info.key, transceiver);
    pcData.order.push(transceiver);
    return transceiver;
  }

  class RTCTrackEvent extends Event {
    constructor(type, init = {}) {
      super(type, init);
      this.receiver = init.receiver;
      this.track = init.track;
      this.streams = Object.freeze([...(init.streams || [])]);
      this.transceiver = init.transceiver;
    }
  }

  // Entfernte Streams mit der Id aus dem SDP (msid), wie in Chrome
  const remoteStreams = new Map();
  function remoteStream(id, track) {
    let stream = remoteStreams.get(id);
    if (!stream) {
      stream = new MediaStream();
      Object.defineProperty(stream, 'id', { value: id, configurable: true });
      remoteStreams.set(id, stream);
    }
    if (track && !stream.getTracks().includes(track))
      stream.addTrack(track);
    return stream;
  }

  // ---------------------------------------------------------------- RTCPeerConnection
  const STATE_NAMES = ['signalingState', 'iceGatheringState', 'iceConnectionState', 'connectionState', 'canTrickleIceCandidates'];
  const DESCRIPTION_NAMES = ['localDescription', 'currentLocalDescription', 'pendingLocalDescription', 'remoteDescription', 'currentRemoteDescription', 'pendingRemoteDescription'];

  class RTCPeerConnection extends EventTarget {
    constructor(configuration = {}) {
      super();
      if (configuration === null || typeof configuration !== 'object')
        configuration = {};
      const id = ++nextId;
      const config = JSON.parse(JSON.stringify(configuration, (key, value) => key === 'certificates' ? undefined : value));
      const self = this;
      const data = {
        id, config, closed: false,
        signalingState: 'stable', iceGatheringState: 'new', iceConnectionState: 'new', connectionState: 'new', canTrickleIceCandidates: null,
        localDescription: null, currentLocalDescription: null, pendingLocalDescription: null,
        remoteDescription: null, currentRemoteDescription: null, pendingRemoteDescription: null,
        chain: null,
        transceivers: new Map(),
        order: [],
        sequence: 0,
        applyTransceivers(list) {
          const seen = new Set();
          for (const info of list) {
            let transceiver = data.transceivers.get(info.key);
            if (!transceiver)
              transceiver = makeTransceiver(self, { ...info, remoteCreated: true });
            const entry = state(transceiver);
            entry.fresh = false;
            entry.mid = info.mid ?? null;
            entry.currentDirection = info.currentDirection ?? null;
            if (entry.direction !== 'stopped' || info.direction === 'stopped')
              entry.direction = info.direction;
            state(entry.sender).parameters = info.sender;
            state(entry.receiver).parameters = info.receiver;
            seen.add(info.key);
          }
          data.order = data.order.filter((transceiver) => seen.has(state(transceiver).key) || state(transceiver).fresh);
        },
        apply(snapshot) {
          if (!snapshot || snapshot.sequence <= data.sequence)
            return;
          data.sequence = snapshot.sequence;
          for (const name of STATE_NAMES) {
            if (snapshot[name] !== undefined)
              data[name] = snapshot[name];
          }
          for (const name of DESCRIPTION_NAMES) {
            if (snapshot[name] !== undefined)
              data[name] = description(snapshot[name]);
          }
          if (snapshot.transceivers)
            data.applyTransceivers(snapshot.transceivers);
        },
        hostEvent(event) {
          if (data.closed)
            return;
          data.apply(event.state);
          switch (event.type) {
          case 'icecandidate':
            self.dispatchEvent(new RTCPeerConnectionIceEvent('icecandidate', { candidate: event.candidate ? new RTCIceCandidate(event.candidate) : null, url: event.url ?? null }));
            break;
          case 'icecandidateerror':
            self.dispatchEvent(new RTCPeerConnectionIceErrorEvent('icecandidateerror', event));
            break;
          case 'datachannel':
            self.dispatchEvent(new RTCDataChannelEvent('datachannel', { channel: makeChannel(self, event.info) }));
            break;
          case 'track': {
            const transceiver = data.transceivers.get(event.transceiver);
            if (!transceiver)
              break;
            const receiver = state(transceiver).receiver;
            const track = receiver.track;
            const streams = (event.streams || []).map((id) => remoteStream(id, track));
            self.dispatchEvent(new RTCTrackEvent('track', { receiver, track, streams, transceiver }));
            break;
          }
          case 'negotiationneeded':
          case 'signalingstatechange':
          case 'iceconnectionstatechange':
          case 'icegatheringstatechange':
          case 'connectionstatechange':
            self.dispatchEvent(new Event(event.type));
            break;
          }
        },
      };
      internal.set(this, data);
      connections.set(id, this);
      data.chain = call('rtc-create', { client, pc: id, config }).then((value) => {
        if (value?.capabilities)
          capabilities = value.capabilities;
        data.apply(value?.state);
      });
      data.chain.catch(() => {});
      poll();
    }

    // Operationen laufen wie in Chrome nacheinander
    _operation(name, payload) {
      const data = state(this);
      if (data.closed)
        return Promise.reject(new DOMException('The RTCPeerConnection\'s signalingState is \'closed\'.', 'InvalidStateError'));
      const result = data.chain.catch(() => {}).then(() => call('rtc-op', { client, pc: data.id, op: name, ...payload })).then((value) => {
        data.apply(value?.state);
        return value;
      });
      data.chain = result.catch(() => {});
      return result;
    }

    createOffer(options) {
      if (typeof options === 'function')
        return this._legacy('createOffer', arguments);
      return this._operation('createOffer', { options: options ?? {} }).then((value) => new RTCSessionDescription(value.description));
    }
    createAnswer(options) {
      if (typeof options === 'function')
        return this._legacy('createAnswer', arguments);
      return this._operation('createAnswer', { options: options ?? {} }).then((value) => new RTCSessionDescription(value.description));
    }
    setLocalDescription(value) {
      return this._operation('setLocalDescription', { description: value ? { type: value.type, sdp: value.sdp } : null }).then(() => undefined);
    }
    setRemoteDescription(value) {
      if (!value || !value.type)
        return Promise.reject(new TypeError("Failed to execute 'setRemoteDescription' on 'RTCPeerConnection': The provided value is not of type 'RTCSessionDescriptionInit'."));
      return this._operation('setRemoteDescription', { description: { type: value.type, sdp: value.sdp ?? '' } }).then(() => undefined);
    }
    addIceCandidate(candidate) {
      if (typeof arguments[1] === 'function')
        return this._legacy('addIceCandidate', arguments);
      const init = candidate ? (typeof candidate.toJSON === 'function' ? candidate.toJSON() : { candidate: candidate.candidate, sdpMid: candidate.sdpMid, sdpMLineIndex: candidate.sdpMLineIndex, usernameFragment: candidate.usernameFragment }) : null;
      return this._operation('addIceCandidate', { candidate: init }).then(() => undefined);
    }
    _legacy(name, args) {
      const [first, success, failure] = args;
      const promise = name === 'addIceCandidate' ? this.addIceCandidate(first) : this[name](typeof first === 'object' ? first : undefined);
      const done = typeof first === 'function' ? first : success;
      const failed = typeof first === 'function' ? success : failure;
      promise.then((value) => done?.(value), (error) => failed?.(error));
      return Promise.resolve();
    }
    restartIce() {
      this._operation('restartIce', {}).catch(() => {});
    }
    getConfiguration() {
      const config = state(this).config;
      return { iceServers: [], iceTransportPolicy: 'all', bundlePolicy: 'balanced', rtcpMuxPolicy: 'require', iceCandidatePoolSize: 0, ...JSON.parse(JSON.stringify(config)), certificates: [] };
    }
    setConfiguration(configuration = {}) {
      const data = state(this);
      data.config = JSON.parse(JSON.stringify(configuration));
      this._operation('setConfiguration', { config: data.config }).catch(() => {});
    }
    createDataChannel(label, init = {}) {
      const data = state(this);
      if (data.closed)
        throw new DOMException("Failed to execute 'createDataChannel' on 'RTCPeerConnection': The RTCPeerConnection's signalingState is 'closed'.", 'InvalidStateError');
      const options = {};
      for (const name of ['ordered', 'maxPacketLifeTime', 'maxRetransmits', 'protocol', 'negotiated', 'id']) {
        if (init[name] !== undefined && init[name] !== null)
          options[name] = init[name];
      }
      const key = client + ':' + data.id + ':' + (++nextId);
      const channel = makeChannel(this, { key, label: String(label), ...options, readyState: 'connecting' });
      const channelData = state(channel);
      channelData.ready = this._operation('createDataChannel', { channel: key, label: String(label), init: options }).then((value) => {
        if (value?.id !== undefined)
          channelData.id = value.id;
      }, (error) => {
        channelData.readyState = 'closed';
        channel.dispatchEvent(new Event('close'));
      });
      return channel;
    }
    getStats(selector) {
      if (selector && typeof MediaStreamTrack === 'function' && selector instanceof MediaStreamTrack) {
        const transceiver = state(this).order.find((t) => state(state(t).sender).track === selector || state(state(t).receiver).track === selector);
        if (!transceiver)
          return Promise.reject(new DOMException('There is no sender or receiver for the track.', 'InvalidAccessError'));
        const sends = state(state(transceiver).sender).track === selector;
        return this._stats(sends ? { sender: state(transceiver).key } : { receiver: state(transceiver).key });
      }
      return this._stats({});
    }
    _stats(selector) {
      return this._operation('getStats', { selector }).then((value) => {
        const report = new Map((value.stats || []).map((entry) => [entry.id, entry]));
        Object.setPrototypeOf(report, RTCStatsReport.prototype);
        return report;
      });
    }
    getSenders() { return state(this).order.map((t) => state(t).sender); }
    getReceivers() { return state(this).order.map((t) => state(t).receiver); }
    getTransceivers() { return [...state(this).order]; }
    addTrack(track, ...streams) {
      const data = state(this);
      if (data.closed)
        throw new DOMException("Failed to execute 'addTrack' on 'RTCPeerConnection': The RTCPeerConnection's signalingState is 'closed'.", 'InvalidStateError');
      if (typeof MediaStreamTrack !== 'function' || !(track instanceof MediaStreamTrack))
        throw new TypeError("Failed to execute 'addTrack' on 'RTCPeerConnection': parameter 1 is not of type 'MediaStreamTrack'.");
      if (data.order.some((t) => state(state(t).sender).track === track))
        throw new DOMException("Failed to execute 'addTrack' on 'RTCPeerConnection': A sender already exists for the track.", 'InvalidAccessError');
      const info = describeTrack(track);
      // Wie Chrome: einen ungenutzten Transceiver aus einem Angebot wiederverwenden
      let transceiver = data.order.find((t) => {
        const entry = state(t);
        return entry.remoteCreated && !entry.everSending && entry.kind === track.kind && entry.direction !== 'stopped' && !state(entry.sender).track;
      });
      const reuse = !!transceiver;
      if (transceiver) {
        const entry = state(transceiver);
        entry.direction = entry.direction === 'recvonly' ? 'sendrecv' : entry.direction === 'inactive' ? 'sendonly' : entry.direction;
      } else
        transceiver = makeTransceiver(this, { key: client + ':t' + (++nextId), kind: track.kind, direction: 'sendrecv' });
      const entry = state(transceiver);
      entry.everSending = true;
      state(entry.sender).track = track;
      this._operation('addTrack', { transceiver: entry.key, reuse, track: info, streams: streams.map((stream) => stream.id) }).catch((e) => reportError(e));
      return entry.sender;
    }
    addTransceiver(trackOrKind, init = {}) {
      const data = state(this);
      if (data.closed)
        throw new DOMException("Failed to execute 'addTransceiver' on 'RTCPeerConnection': The RTCPeerConnection's signalingState is 'closed'.", 'InvalidStateError');
      const track = typeof trackOrKind === 'string' ? null : trackOrKind;
      const kind = typeof trackOrKind === 'string' ? trackOrKind : track?.kind;
      if (kind !== 'audio' && kind !== 'video')
        throw new TypeError(`Failed to execute 'addTransceiver' on 'RTCPeerConnection': The provided value '${kind}' is not a valid enum value of type MediaStreamTrackKind.`);
      const direction = init.direction ?? 'sendrecv';
      if (!DIRECTIONS.includes(direction))
        throw new TypeError(`The provided value '${direction}' is not a valid enum value of type RTCRtpTransceiverDirection.`);
      const info = describeTrack(track);
      const transceiver = makeTransceiver(this, { key: client + ':t' + (++nextId), kind, direction });
      const entry = state(transceiver);
      entry.everSending = !!track;
      state(entry.sender).track = track;
      this._operation('addTransceiver', { transceiver: entry.key, kind, track: info, init: { direction, streams: (init.streams || []).map((stream) => stream.id), sendEncodings: copy(init.sendEncodings) } }).catch((e) => reportError(e));
      return transceiver;
    }
    removeTrack(sender) {
      const data = state(this);
      if (data.closed)
        throw new DOMException("Failed to execute 'removeTrack' on 'RTCPeerConnection': The RTCPeerConnection's signalingState is 'closed'.", 'InvalidStateError');
      if (!(sender instanceof RTCRtpSender))
        throw new TypeError("Failed to execute 'removeTrack' on 'RTCPeerConnection': parameter 1 is not of type 'RTCRtpSender'.");
      const entry = state(sender);
      if (entry.pc !== this)
        throw new DOMException("Failed to execute 'removeTrack' on 'RTCPeerConnection': The sender was not created by this peer connection.", 'InvalidAccessError');
      if (!entry.track)
        return;
      entry.track = null;
      const transceiver = state(entry.transceiver);
      transceiver.direction = transceiver.direction === 'sendrecv' ? 'recvonly' : transceiver.direction === 'sendonly' ? 'inactive' : transceiver.direction;
      this._operation('removeTrack', { transceiver: entry.key }).catch(() => {});
    }
    close() {
      const data = state(this);
      if (data.closed)
        return;
      data.closed = true;
      data.signalingState = 'closed';
      data.iceConnectionState = 'closed';
      data.connectionState = 'closed';
      for (const [key, channel] of channels) {
        const channelData = state(channel);
        if (channelData.connection === this) {
          channelData.readyState = 'closed';
          channels.delete(key);
        }
      }
      connections.delete(data.id);
      data.chain.catch(() => {}).then(() => call('rtc-close', { client, pc: data.id })).catch(() => {});
    }
    get sctp() { return null; }
    static generateCertificate() { return Promise.reject(new DOMException('Not supported', 'NotSupportedError')); }
  }
  for (const name of [...STATE_NAMES, ...DESCRIPTION_NAMES])
    Object.defineProperty(RTCPeerConnection.prototype, name, { get() { return state(this)[name]; }, configurable: true, enumerable: true });
  eventHandlers(RTCPeerConnection.prototype, ['negotiationneeded', 'icecandidate', 'icecandidateerror', 'signalingstatechange', 'iceconnectionstatechange',
    'icegatheringstatechange', 'connectionstatechange', 'datachannel', 'track']);

  class RTCStatsReport extends Map {}

  // ---------------------------------------------------------------- Picture-in-Picture
  // Das <video> der Seite hat im Host ein verstecktes <video> (web/media.js), das
  // geht ins PiP-Fenster von Chrome (mit Ton und Bedienelementen).
  if (typeof HTMLVideoElement === 'function' && !('requestPictureInPicture' in HTMLVideoElement.prototype)) {
    let pipElement = null;
    let pipWindow = null;
    class PictureInPictureWindow extends EventTarget {
      constructor() {
        throw new TypeError('Illegal constructor');
      }
      get width() { return state(this).width; }
      get height() { return state(this).height; }
    }
    eventHandlers(PictureInPictureWindow.prototype, ['resize']);
    class PictureInPictureEvent extends Event {
      constructor(type, init = {}) {
        super(type, init);
        this.pictureInPictureWindow = init.pictureInPictureWindow;
      }
    }
    Object.defineProperty(Document.prototype, 'pictureInPictureEnabled', { get() { return true; }, configurable: true, enumerable: true });
    Object.defineProperty(Document.prototype, 'pictureInPictureElement', {
      get() { return pipElement && pipElement.isConnected && pipElement.ownerDocument === this ? pipElement : null; },
      configurable: true,
      enumerable: true,
    });
    if (typeof ShadowRoot === 'function')
      Object.defineProperty(ShadowRoot.prototype, 'pictureInPictureElement', { get() { return null; }, configurable: true, enumerable: true });
    Object.defineProperty(HTMLVideoElement.prototype, 'disablePictureInPicture', {
      get() { return this.hasAttribute('disablepictureinpicture'); },
      set(value) { this.toggleAttribute('disablepictureinpicture', !!value); },
      configurable: true,
      enumerable: true,
    });
    eventHandlers(HTMLVideoElement.prototype, ['enterpictureinpicture', 'leavepictureinpicture']);
    const leave = () => {
      if (!pipElement)
        return;
      const element = pipElement;
      const window = pipWindow;
      pipElement = null;
      pipWindow = null;
      state(window).width = 0;
      state(window).height = 0;
      element.dispatchEvent(new PictureInPictureEvent('leavepictureinpicture', { bubbles: true, pictureInPictureWindow: window }));
    };
    const watch = async (player, element, window) => {
      while (pipElement === element) {
        let event;
        try {
          event = await call('pip-wait', { player });
        } catch (e) {
          break;
        }
        if (pipElement !== element)
          break;
        if (event?.type === 'resize') {
          state(window).width = event.width;
          state(window).height = event.height;
          window.dispatchEvent(new Event('resize'));
        } else if (event?.type === 'leave') {
          leave();
          break;
        }
      }
    };
    define(HTMLVideoElement.prototype, 'requestPictureInPicture', async function requestPictureInPicture() {
      if (this.disablePictureInPicture)
        throw new DOMException("Failed to execute 'requestPictureInPicture' on 'HTMLVideoElement': \"disablePictureInPicture\" attribute is present.", 'InvalidStateError');
      if (this.readyState === 0)
        throw new DOMException("Failed to execute 'requestPictureInPicture' on 'HTMLVideoElement': Metadata for the video element are not loaded yet.", 'InvalidStateError');
      const player = media ? media('player', this) : 0;
      if (!player)
        throw new DOMException("Failed to execute 'requestPictureInPicture' on 'HTMLVideoElement': Picture-in-Picture is not available for this video.", 'NotSupportedError');
      const size = await call('pip-enter', { player });
      leave();
      const window = Reflect.construct(EventTarget, [], PictureInPictureWindow);
      internal.set(window, { width: size.width, height: size.height });
      pipElement = this;
      pipWindow = window;
      this.dispatchEvent(new PictureInPictureEvent('enterpictureinpicture', { bubbles: true, pictureInPictureWindow: window }));
      watch(player, this, window);
      return window;
    });
    define(Document.prototype, 'exitPictureInPicture', async function exitPictureInPicture() {
      if (!pipElement)
        throw new DOMException("Failed to execute 'exitPictureInPicture' on 'Document': There is no Picture-in-Picture element in this document.", 'InvalidStateError');
      await call('pip-exit', {});
      leave();
    });
    define(globalThis, 'PictureInPictureWindow', PictureInPictureWindow);
    define(globalThis, 'PictureInPictureEvent', PictureInPictureEvent);
  }

  define(globalThis, 'RTCPeerConnection', RTCPeerConnection);
  define(globalThis, 'webkitRTCPeerConnection', RTCPeerConnection);
  define(globalThis, 'RTCSessionDescription', RTCSessionDescription);
  define(globalThis, 'RTCIceCandidate', RTCIceCandidate);
  define(globalThis, 'RTCDataChannel', RTCDataChannel);
  define(globalThis, 'RTCPeerConnectionIceEvent', RTCPeerConnectionIceEvent);
  define(globalThis, 'RTCPeerConnectionIceErrorEvent', RTCPeerConnectionIceErrorEvent);
  define(globalThis, 'RTCDataChannelEvent', RTCDataChannelEvent);
  define(globalThis, 'RTCError', RTCError);
  define(globalThis, 'RTCErrorEvent', RTCErrorEvent);
  define(globalThis, 'RTCStatsReport', RTCStatsReport);
  define(globalThis, 'RTCRtpSender', RTCRtpSender);
  define(globalThis, 'RTCRtpReceiver', RTCRtpReceiver);
  define(globalThis, 'RTCRtpTransceiver', RTCRtpTransceiver);
  define(globalThis, 'RTCTrackEvent', RTCTrackEvent);
})();
)JS";

} // namespace BrowserLite
