// WebRTC der Seiten (engine/src/WebRTCPolyfill.cpp): jede RTCPeerConnection
// und jeder RTCDataChannel der Seite hat hier ein echtes Gegenstueck im
// Host-Browser. Ereignisse sammeln wir pro Seite (client) und geben sie mit
// "rtc-poll" ab; die Seite fragt in einer Schleife.
//
// Achtung: die Verbindungen laufen ueber das Netz des Host-Browsers, nicht
// ueber das Relay (wie Chrome zeigt die Gegenseite die IP des Geraets).

import { captureTrack, captureApi } from './capture.js';
import { bytesToBase64, base64ToBytes, domError } from './util.js';

const POLL_WAIT = 20000;
const CLIENT_TIMEOUT = 60000;

const clients = new Map(); // client -> Zustand

function clientFor(id, origin, create) {
  if (typeof id !== 'string' || !id)
    throw domError('InvalidAccessError', 'Missing client');
  let client = clients.get(id);
  if (!client) {
    if (!create)
      throw domError('InvalidStateError', 'Unknown connection');
    client = {
      origin, pcs: new Map(), channels: new Map(), channelPc: new Map(), queue: [], waiter: null, lastSeen: Date.now(), remoteChannels: 0,
      // Medien: Transceiver per Schluessel, Host-Spuren der Seite per Spur-Id
      transceivers: new Map(), transceiverKeys: new WeakMap(), transceiverPc: new Map(), remoteTransceivers: 0, tracks: new Map(),
      toPage: new Map(), toHost: new Map(),
    };
    clients.set(id, client);
  }
  // Verbindungen gehoeren dem Ursprung, der sie gemacht hat
  if (client.origin !== origin)
    throw domError('SecurityError', 'Wrong origin');
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

// Ids im SDP (a=msid:<stream> <spur>): die Seite und die Gegenstelle sollen die
// Ids der Seite sehen, nicht die der Host-Objekte. Beim Zuruecksetzen
// (setLocalDescription) wird wieder auf die Host-Ids getauscht.
function mapId(client, hostId, pageId) {
  if (!hostId || !pageId || hostId === pageId)
    return;
  client.toPage.set(hostId, pageId);
  client.toHost.set(pageId, hostId);
}

function swapIds(sdp, map) {
  if (!sdp || !map.size)
    return sdp;
  for (const [from, to] of map)
    sdp = sdp.split(from).join(to);
  return sdp;
}

const describe = (value, client) => value ? { type: value.type, sdp: client ? swapIds(value.sdp, client.toPage) : value.sdp } : null;

// Schnappschuesse kommen ueber verschiedene Antworten an (Operation, Ereignis);
// die Nummer sagt der Seite, welcher neuer ist
function transceiverKey(client, pcId, transceiver) {
  let key = client.transceiverKeys.get(transceiver);
  if (!key) {
    key = `r${++client.remoteTransceivers}`;
    client.transceiverKeys.set(transceiver, key);
    client.transceivers.set(key, transceiver);
    client.transceiverPc.set(key, pcId);
  }
  return key;
}

const json = (value) => {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (e) {
    return undefined;
  }
};

function snapshot(pc, client, pcId) {
  pc.blSequence = (pc.blSequence || 0) + 1;
  const transceivers = client ? pc.getTransceivers().map((transceiver) => ({
    key: transceiverKey(client, pcId, transceiver), kind: transceiver.receiver.track.kind, mid: transceiver.mid,
    direction: transceiver.direction, currentDirection: transceiver.currentDirection,
    sender: json(transceiver.sender.getParameters()), receiver: json(transceiver.receiver.getParameters()),
  })) : undefined;
  return {
    sequence: pc.blSequence,
    transceivers,
    signalingState: pc.signalingState, iceGatheringState: pc.iceGatheringState, iceConnectionState: pc.iceConnectionState,
    connectionState: pc.connectionState, canTrickleIceCandidates: pc.canTrickleIceCandidates ?? null,
    localDescription: describe(pc.localDescription, client), currentLocalDescription: describe(pc.currentLocalDescription, client),
    pendingLocalDescription: describe(pc.pendingLocalDescription, client), remoteDescription: describe(pc.remoteDescription, client),
    currentRemoteDescription: describe(pc.currentRemoteDescription, client), pendingRemoteDescription: describe(pc.pendingRemoteDescription, client),
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

// Spur der Seite -> Spur im Host. Kamera/Mikrofon: Kopie der echten Spur; sonst
// ein MediaStreamTrackGenerator, in den der Engine-Worker schreibt
async function hostTrack(client, info) {
  if (!info)
    return null;
  let track = client.tracks.get(info.id);
  if (track && track.readyState !== 'ended')
    return track;
  if (info.capture) {
    const original = await captureTrack(info.capture);
    if (!original)
      throw domError('InvalidStateError', 'The track has ended.');
    track = original.clone();
  } else if (info.sink && typeof MediaStreamTrackGenerator === 'function') {
    track = new MediaStreamTrackGenerator({ kind: info.kind });
    const worker = captureApi()?.engineWorker();
    if (!worker)
      throw domError('InvalidStateError', 'No engine');
    worker.postMessage({ blSink: { id: info.sink, writable: track.writable } }, [track.writable]);
  } else
    throw domError('NotSupportedError', 'This track cannot be sent');
  track.enabled = info.enabled !== false;
  client.tracks.set(info.id, track);
  mapId(client, track.id, info.id);
  return track;
}

const streamsFor = (client, ids) => (ids || []).map((id) => {
  client.streams ??= new Map();
  let stream = client.streams.get(id);
  if (!stream) {
    stream = new MediaStream();
    client.streams.set(id, stream);
    mapId(client, stream.id, id);
  }
  return stream;
});

function transceiverFor(client, key) {
  const transceiver = client.transceivers.get(key);
  if (!transceiver)
    throw domError('InvalidStateError', 'Unknown transceiver');
  return transceiver;
}

function remember(client, pcId, key, transceiver) {
  client.transceivers.set(key, transceiver);
  client.transceiverKeys.set(transceiver, key);
  client.transceiverPc.set(key, pcId);
}

function connection(client, id) {
  const pc = client.pcs.get(id);
  if (!pc)
    throw domError('InvalidStateError', 'The RTCPeerConnection is closed.');
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
  for (const [key, pcId] of client.transceiverPc) {
    if (pcId === id) {
      client.transceivers.delete(key);
      client.transceiverPc.delete(key);
    }
  }
  // Host-Spuren, die keine offene Verbindung mehr sendet, anhalten (Kamera-Kopie
  // freigeben, Generator schliessen); beim naechsten addTrack gibt es neue
  const used = new Set();
  for (const other of client.pcs.values()) {
    for (const sender of other.getSenders()) {
      if (sender.track)
        used.add(sender.track);
    }
  }
  for (const [pageId, track] of client.tracks) {
    if (!used.has(track)) {
      track.stop();
      client.tracks.delete(pageId);
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
  for (const track of client.tracks.values())
    track.stop();
  client.tracks.clear();
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
  async createOffer(pc, payload, client) {
    return { description: describe(await pc.createOffer(payload.options || {}), client) };
  },
  async createAnswer(pc, payload, client) {
    return { description: describe(await pc.createAnswer(payload.options || {}), client) };
  },
  async setLocalDescription(pc, payload, client) {
    const description = payload.description && { type: payload.description.type, sdp: swapIds(payload.description.sdp, client.toHost) };
    await (description ? pc.setLocalDescription(description) : pc.setLocalDescription());
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
      throw domError('OperationError', 'Bad channel');
    const channel = pc.createDataChannel(String(payload.label ?? ''), payload.init || {});
    wireChannel(client, payload.pc, payload.channel, channel);
    return { id: channel.id };
  },
  async addTrack(pc, payload, client) {
    const track = await hostTrack(client, payload.track);
    const streams = streamsFor(client, payload.streams);
    if (payload.reuse) {
      // Wie addTrack mit einem ungenutzten Transceiver aus einem Angebot
      const transceiver = transceiverFor(client, payload.transceiver);
      await transceiver.sender.replaceTrack(track);
      transceiver.sender.setStreams?.(...streams);
      transceiver.direction = transceiver.direction === 'recvonly' ? 'sendrecv' : transceiver.direction === 'inactive' ? 'sendonly' : transceiver.direction;
    } else {
      const transceiver = pc.addTransceiver(track, { direction: 'sendrecv', streams });
      remember(client, payload.pc, payload.transceiver, transceiver);
    }
    return {};
  },
  async addTransceiver(pc, payload, client) {
    const init = { direction: payload.init?.direction ?? 'sendrecv', streams: streamsFor(client, payload.init?.streams) };
    if (payload.init?.sendEncodings)
      init.sendEncodings = payload.init.sendEncodings;
    const transceiver = pc.addTransceiver(payload.track ? await hostTrack(client, payload.track) : payload.kind, init);
    remember(client, payload.pc, payload.transceiver, transceiver);
    return {};
  },
  async removeTrack(pc, payload, client) {
    pc.removeTrack(transceiverFor(client, payload.transceiver).sender);
    return {};
  },
  async replaceTrack(pc, payload, client) {
    await transceiverFor(client, payload.transceiver).sender.replaceTrack(await hostTrack(client, payload.track));
    return {};
  },
  async setStreams(pc, payload, client) {
    transceiverFor(client, payload.transceiver).sender.setStreams?.(...streamsFor(client, payload.streams));
    return {};
  },
  async setParameters(pc, payload, client) {
    await transceiverFor(client, payload.transceiver).sender.setParameters(payload.parameters);
    return {};
  },
  async setDirection(pc, payload, client) {
    transceiverFor(client, payload.transceiver).direction = payload.direction;
    return {};
  },
  async stopTransceiver(pc, payload, client) {
    transceiverFor(client, payload.transceiver).stop();
    return {};
  },
  async setCodecPreferences(pc, payload, client) {
    transceiverFor(client, payload.transceiver).setCodecPreferences(payload.codecs || []);
    return {};
  },
  async getStats(pc, payload, client) {
    let source = pc;
    if (payload.selector?.sender)
      source = transceiverFor(client, payload.selector.sender).sender;
    else if (payload.selector?.receiver)
      source = transceiverFor(client, payload.selector.receiver).receiver;
    const report = await source.getStats();
    return { stats: [...report.values()].map((entry) => JSON.parse(JSON.stringify(entry))) };
  },
};

export const rtcHostCalls = {
  async 'rtc-create'(payload, origin) {
    if (typeof RTCPeerConnection !== 'function')
      throw domError('NotSupportedError', 'WebRTC is not available');
    const client = clientFor(payload?.client, origin, true);
    const id = payload.pc;
    if (client.pcs.has(id))
      throw domError('InvalidStateError', 'Duplicate connection');
    const pc = new RTCPeerConnection(sanitizeConfig(payload.config));
    client.pcs.set(id, pc);
    const forward = (type) => () => push(client, { pc: id, type, state: snapshot(pc, client, id) });
    pc.onicecandidate = (event) => push(client, { pc: id, type: 'icecandidate', candidate: event.candidate ? event.candidate.toJSON() : null, url: event.url ?? null, state: snapshot(pc, client, id) });
    pc.onicecandidateerror = (event) => push(client, { pc: id, type: 'icecandidateerror', address: event.address, port: event.port, url: event.url, errorCode: event.errorCode, errorText: event.errorText, state: snapshot(pc, client, id) });
    for (const type of ['negotiationneeded', 'signalingstatechange', 'iceconnectionstatechange', 'icegatheringstatechange', 'connectionstatechange'])
      pc.addEventListener(type, forward(type));
    pc.ontrack = (event) => {
      const key = transceiverKey(client, id, event.transceiver);
      push(client, { pc: id, type: 'track', transceiver: key, streams: event.streams.map((stream) => stream.id), state: snapshot(pc, client, id) });
    };
    pc.ondatachannel = (event) => {
      const key = `${payload.client}:r${++client.remoteChannels}`;
      wireChannel(client, id, key, event.channel);
      push(client, { pc: id, type: 'datachannel', info: channelInfo(key, event.channel), state: snapshot(pc, client, id) });
    };
    const capabilities = { sender: {}, receiver: {} };
    for (const kind of ['audio', 'video']) {
      capabilities.sender[kind] = json(RTCRtpSender.getCapabilities?.(kind));
      capabilities.receiver[kind] = json(RTCRtpReceiver.getCapabilities?.(kind));
    }
    return { state: snapshot(pc, client, id), capabilities };
  },
  async 'rtc-op'(payload, origin) {
    const client = clientFor(payload?.client, origin, false);
    const pc = connection(client, payload.pc);
    const operation = operations[payload.op];
    if (!operation)
      throw domError('NotSupportedError', 'Unknown operation');
    const result = await operation(pc, payload, client);
    return { ...result, state: snapshot(pc, client, payload.pc) };
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
  // Die Seite schaut die Spur eines Empfaengers an: Bilder/Ton an die Engine
  async 'rtc-receive'(payload, origin) {
    const client = clientFor(payload?.client, origin, false);
    const track = transceiverFor(client, payload.transceiver).receiver.track;
    const api = captureApi();
    const worker = api?.engineWorker();
    if (!worker || typeof MediaStreamTrackProcessor !== 'function')
      throw domError('NotSupportedError', 'MediaStreamTrackProcessor is missing');
    const source = Number(payload.source);
    const processor = new MediaStreamTrackProcessor({ track });
    worker.postMessage({ blCapture: { id: source, kind: track.kind, readable: processor.readable } }, [processor.readable]);
    // Chrome zieht Ton von WebRTC nur, wenn er irgendwo abgespielt wird: ein
    // stummes <audio> im Host haelt ihn am Laufen (hoerbar macht ihn die Engine)
    let player = null;
    if (track.kind === 'audio') {
      player = new Audio();
      player.muted = true;
      player.srcObject = new MediaStream([track]);
      player.play().catch(() => {});
    }
    const engine = api.engine();
    const muted = (value) => engine._bl_remote_muted(source, value ? 1 : 0);
    if (track.muted)
      muted(true);
    track.addEventListener('mute', () => muted(true));
    track.addEventListener('unmute', () => muted(false));
    track.addEventListener('ended', () => {
      if (player)
        player.srcObject = null;
      api.engine()._bl_capture_ended(source);
    }, { once: true });
    return {};
  },
  async 'rtc-track'(payload, origin) {
    const client = clientFor(payload?.client, origin, false);
    const track = client.tracks.get(payload.track);
    if (!track)
      return {};
    if (payload.stop) {
      track.stop();
      client.tracks.delete(payload.track);
    } else if (typeof payload.enabled === 'boolean')
      track.enabled = payload.enabled;
    return {};
  },
  async 'rtc-send'(payload, origin) {
    const client = clientFor(payload?.client, origin, false);
    const channel = client.channels.get(payload.channel);
    if (!channel || channel.readyState !== 'open')
      throw domError('InvalidStateError', "RTCDataChannel.readyState is not 'open'");
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
