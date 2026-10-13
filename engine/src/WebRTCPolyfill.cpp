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
        sequence: 0,
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
      data.chain = call('rtc-create', { client, pc: id, config });
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
    getStats() {
      return this._operation('getStats', {}).then((value) => {
        const report = new Map((value.stats || []).map((entry) => [entry.id, entry]));
        Object.setPrototypeOf(report, RTCStatsReport.prototype);
        return report;
      });
    }
    getSenders() { return []; }
    getReceivers() { return []; }
    getTransceivers() { return []; }
    addTrack() { throw new DOMException('Media tracks are not supported yet', 'NotSupportedError'); }
    addTransceiver() { throw new DOMException('Media tracks are not supported yet', 'NotSupportedError'); }
    removeTrack() { }
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
})();
)JS";

} // namespace BrowserLite
