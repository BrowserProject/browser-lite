// WebRTC der Seiten (engine/src/WebRTCPolyfill.cpp): jede RTCPeerConnection
// und jeder RTCDataChannel der Seite hat hier ein echtes Gegenstueck im
// Host-Browser. Ereignisse sammeln wir pro Seite (client) und geben sie mit
// "rtc-poll" ab; die Seite fragt in einer Schleife.
//
// Achtung: die Verbindungen laufen ueber das Netz des Host-Browsers, nicht
// ueber das Relay (wie Chrome zeigt die Gegenseite die IP des Geraets).

const POLL_WAIT = 20000;
const CLIENT_TIMEOUT = 60000;

const clients = new Map(); // client -> Zustand

function rtcError(name, message) {
  const error = new Error(message);
  error.name = name;
  return error;
}

function bytesToBase64(bytes) {
  if (typeof bytes.toBase64 === 'function')
    return bytes.toBase64();
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function base64ToBytes(text) {
  if (typeof Uint8Array.fromBase64 === 'function')
    return Uint8Array.fromBase64(text);
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

function clientFor(id, origin, create) {
  if (typeof id !== 'string' || !id)
    throw rtcError('InvalidAccessError', 'Missing client');
  let client = clients.get(id);
  if (!client) {
    if (!create)
      throw rtcError('InvalidStateError', 'Unknown connection');
    client = { origin, pcs: new Map(), channels: new Map(), channelPc: new Map(), queue: [], waiter: null, lastSeen: Date.now(), remoteChannels: 0 };
    clients.set(id, client);
  }
  // Verbindungen gehoeren dem Ursprung, der sie gemacht hat
  if (client.origin !== origin)
    throw rtcError('SecurityError', 'Wrong origin');
  client.lastSeen = Date.now();
  return client;
}

function push(client, event) {
  client.queue.push(event);
  if (client.waiter) {
    const wake = client.waiter;
    client.waiter = null;
    wake();
  }
}

const describe = (value) => value ? { type: value.type, sdp: value.sdp } : null;

// Schnappschuesse kommen ueber verschiedene Antworten an (Operation, Ereignis);
// die Nummer sagt der Seite, welcher neuer ist
function snapshot(pc) {
  pc.blSequence = (pc.blSequence || 0) + 1;
  return {
    sequence: pc.blSequence,
    signalingState: pc.signalingState, iceGatheringState: pc.iceGatheringState, iceConnectionState: pc.iceConnectionState,
    connectionState: pc.connectionState, canTrickleIceCandidates: pc.canTrickleIceCandidates ?? null,
    localDescription: describe(pc.localDescription), currentLocalDescription: describe(pc.currentLocalDescription),
    pendingLocalDescription: describe(pc.pendingLocalDescription), remoteDescription: describe(pc.remoteDescription),
    currentRemoteDescription: describe(pc.currentRemoteDescription), pendingRemoteDescription: describe(pc.pendingRemoteDescription),
  };
}

function channelInfo(key, channel) {
  return {
    key, label: channel.label, ordered: channel.ordered, maxPacketLifeTime: channel.maxPacketLifeTime, maxRetransmits: channel.maxRetransmits,
    protocol: channel.protocol, negotiated: channel.negotiated, id: channel.id, readyState: channel.readyState,
  };
}

function wireChannel(client, pcId, key, channel) {
  channel.binaryType = 'arraybuffer';
  client.channels.set(key, channel);
  client.channelPc.set(key, pcId);
  channel.onopen = () => push(client, { channel: key, type: 'open', id: channel.id });
  channel.onmessage = (event) => {
    if (typeof event.data === 'string')
      push(client, { channel: key, type: 'message', text: event.data });
    else
      push(client, { channel: key, type: 'message', binary: bytesToBase64(new Uint8Array(event.data)) });
  };
  channel.onbufferedamountlow = () => push(client, { channel: key, type: 'bufferedamountlow' });
  channel.onerror = (event) => push(client, { channel: key, type: 'error', errorDetail: event.error?.errorDetail, message: event.error?.message });
  channel.onclosing = () => push(client, { channel: key, type: 'closing' });
  channel.onclose = () => {
    push(client, { channel: key, type: 'close' });
    client.channels.delete(key);
    client.channelPc.delete(key);
  };
}

function connection(client, id) {
  const pc = client.pcs.get(id);
  if (!pc)
    throw rtcError('InvalidStateError', 'The RTCPeerConnection is closed.');
  return pc;
}

function closeConnection(client, id) {
  const pc = client.pcs.get(id);
  if (!pc)
    return;
  client.pcs.delete(id);
  for (const [key, pcId] of client.channelPc) {
    if (pcId === id) {
      client.channels.delete(key);
      client.channelPc.delete(key);
    }
  }
  try {
    pc.close();
  } catch (e) {
  }
}

function closeClient(id) {
  const client = clients.get(id);
  if (!client)
    return;
  clients.delete(id);
  for (const pcId of [...client.pcs.keys()])
    closeConnection(client, pcId);
  client.waiter?.();
}

// Fuer die Tests (tests/e2e/webrtc-test.mjs)
window.__blRtcState = () => [...clients.values()].map((client) => ({
  pcs: [...client.pcs.values()].map((pc) => pc.iceGatheringState + '/' + pc.signalingState), queue: client.queue.length, waiting: !!client.waiter,
}));

// Seiten, die nicht mehr fragen (Tab zu, Absturz), raeumen wir weg
setInterval(() => {
  const now = Date.now();
  for (const [id, client] of clients) {
    if (!client.waiter && now - client.lastSeen > CLIENT_TIMEOUT)
      closeClient(id);
  }
}, CLIENT_TIMEOUT / 2);

function sanitizeConfig(config) {
  const result = {};
  if (Array.isArray(config?.iceServers)) {
    result.iceServers = config.iceServers.map((server) => {
      const entry = { urls: server.urls ?? server.url };
      if (server.username !== undefined)
        entry.username = String(server.username);
      if (server.credential !== undefined)
        entry.credential = String(server.credential);
      return entry;
    });
  }
  for (const name of ['iceTransportPolicy', 'bundlePolicy', 'rtcpMuxPolicy', 'iceCandidatePoolSize'])
    if (config?.[name] !== undefined)
      result[name] = config[name];
  return result;
}

const operations = {
  async createOffer(pc, payload) {
    return { description: describe(await pc.createOffer(payload.options || {})) };
  },
  async createAnswer(pc, payload) {
    return { description: describe(await pc.createAnswer(payload.options || {})) };
  },
  async setLocalDescription(pc, payload) {
    await (payload.description ? pc.setLocalDescription(payload.description) : pc.setLocalDescription());
    return {};
  },
  async setRemoteDescription(pc, payload) {
    await pc.setRemoteDescription(payload.description);
    return {};
  },
  async addIceCandidate(pc, payload) {
    await pc.addIceCandidate(payload.candidate ?? undefined);
    return {};
  },
  async restartIce(pc) {
    pc.restartIce();
    return {};
  },
  async setConfiguration(pc, payload) {
    pc.setConfiguration(sanitizeConfig(payload.config));
    return {};
  },
  async createDataChannel(pc, payload, client) {
    if (typeof payload.channel !== 'string' || client.channels.has(payload.channel))
      throw rtcError('OperationError', 'Bad channel');
    const channel = pc.createDataChannel(String(payload.label ?? ''), payload.init || {});
    wireChannel(client, payload.pc, payload.channel, channel);
    return { id: channel.id };
  },
  async getStats(pc) {
    const report = await pc.getStats();
    return { stats: [...report.values()].map((entry) => JSON.parse(JSON.stringify(entry))) };
  },
};

export const rtcHostCalls = {
  async 'rtc-create'(payload, origin) {
    if (typeof RTCPeerConnection !== 'function')
      throw rtcError('NotSupportedError', 'WebRTC is not available');
    const client = clientFor(payload?.client, origin, true);
    const id = payload.pc;
    if (client.pcs.has(id))
      throw rtcError('InvalidStateError', 'Duplicate connection');
    const pc = new RTCPeerConnection(sanitizeConfig(payload.config));
    client.pcs.set(id, pc);
    const forward = (type) => () => push(client, { pc: id, type, state: snapshot(pc) });
    pc.onicecandidate = (event) => push(client, { pc: id, type: 'icecandidate', candidate: event.candidate ? event.candidate.toJSON() : null, url: event.url ?? null, state: snapshot(pc) });
    pc.onicecandidateerror = (event) => push(client, { pc: id, type: 'icecandidateerror', address: event.address, port: event.port, url: event.url, errorCode: event.errorCode, errorText: event.errorText, state: snapshot(pc) });
    for (const type of ['negotiationneeded', 'signalingstatechange', 'iceconnectionstatechange', 'icegatheringstatechange', 'connectionstatechange'])
      pc.addEventListener(type, forward(type));
    pc.ondatachannel = (event) => {
      const key = `${payload.client}:r${++client.remoteChannels}`;
      wireChannel(client, id, key, event.channel);
      push(client, { pc: id, type: 'datachannel', info: channelInfo(key, event.channel), state: snapshot(pc) });
    };
    return { state: snapshot(pc) };
  },
  async 'rtc-op'(payload, origin) {
    const client = clientFor(payload?.client, origin, false);
    const pc = connection(client, payload.pc);
    const operation = operations[payload.op];
    if (!operation)
      throw rtcError('NotSupportedError', 'Unknown operation');
    const result = await operation(pc, payload, client);
    return { ...result, state: snapshot(pc) };
  },
  async 'rtc-poll'(payload, origin) {
    const client = clientFor(payload?.client, origin, true);
    if (!client.queue.length) {
      await new Promise((resolve) => {
        client.waiter = resolve;
        setTimeout(() => {
          if (client.waiter === resolve)
            client.waiter = null;
          resolve();
        }, POLL_WAIT);
      });
    }
    client.lastSeen = Date.now();
    return client.queue.splice(0);
  },
  async 'rtc-send'(payload, origin) {
    const client = clientFor(payload?.client, origin, false);
    const channel = client.channels.get(payload.channel);
    if (!channel || channel.readyState !== 'open')
      throw rtcError('InvalidStateError', "RTCDataChannel.readyState is not 'open'");
    channel.send(payload.binary !== undefined ? base64ToBytes(payload.binary) : String(payload.text ?? ''));
    return { bufferedAmount: channel.bufferedAmount };
  },
  async 'rtc-channel'(payload, origin) {
    const client = clientFor(payload?.client, origin, false);
    const channel = client.channels.get(payload.channel);
    if (channel && typeof payload.threshold === 'number')
      channel.bufferedAmountLowThreshold = payload.threshold;
    return {};
  },
  async 'rtc-channel-close'(payload, origin) {
    const client = clientFor(payload?.client, origin, false);
    client.channels.get(payload.channel)?.close();
    return {};
  },
  async 'rtc-close'(payload, origin) {
    const client = clientFor(payload?.client, origin, false);
    closeConnection(client, payload.pc);
    return {};
  },
  async 'rtc-close-all'(payload, origin) {
    clientFor(payload?.client, origin, false);
    closeClient(payload.client);
    return {};
  },
};
