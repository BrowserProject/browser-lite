import { base64ToBytes, bytesToBase64, domError } from '../util.js';
import type { CaptureApi } from './capture.js';
import { trackGenerator, trackProcessor } from './host-apis.js';
import { Service, type ServiceContext } from './service.js';

const POLL_WAIT = 20000;
const CLIENT_TIMEOUT = 60000;

interface TrackInfo {
  id: string;
  kind: string;
  capture?: number;
  sink?: number;
  enabled?: boolean;
}

interface Payload {
  client?: string;
  pc?: string;
  op?: string;
  config?: RTCConfigurationLike;
  options?: RTCOfferOptions;
  description?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit | null;
  channel?: string;
  label?: string;
  init?: Record<string, unknown>;
  track?: TrackInfo;
  streams?: string[];
  reuse?: boolean;
  transceiver?: string;
  kind?: string;
  parameters?: RTCRtpSendParameters;
  direction?: RTCRtpTransceiverDirection;
  codecs?: RTCRtpCodec[];
  selector?: { sender?: string; receiver?: string };
  source?: number;
  stop?: boolean;
  enabled?: boolean;
  binary?: string;
  text?: string;
  threshold?: number;
}

interface RTCConfigurationLike {
  iceServers?: {
    urls?: string | string[];
    url?: string;
    username?: unknown;
    credential?: unknown;
  }[];
  [key: string]: unknown;
}

interface Client {
  origin: string;
  pcs: Map<string, RTCPeerConnection & { blSequence?: number }>;
  channels: Map<string, RTCDataChannel>;
  channelPc: Map<string, string>;
  queue: unknown[];
  waiter: (() => void) | null;
  lastSeen: number;
  remoteChannels: number;
  transceivers: Map<string, RTCRtpTransceiver>;
  transceiverKeys: WeakMap<RTCRtpTransceiver, string>;
  transceiverPc: Map<string, string>;
  remoteTransceivers: number;
  tracks: Map<string, MediaStreamTrack>;
  streams: Map<string, MediaStream>;
  toPage: Map<string, string>;
  toHost: Map<string, string>;
}

type Operation = (
  pc: RTCPeerConnection,
  payload: Payload,
  client: Client,
) => Promise<Record<string, unknown>>;

const json = (value: unknown): unknown => {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return undefined;
  }
};

// Ids in the SDP (a=msid:<stream> <track>): the page and the remote side see the page's ids,
// not those of the host objects; setLocalDescription swaps back to the host ids
function mapId(client: Client, hostId: string, pageId: string): void {
  if (!hostId || !pageId || hostId === pageId) return;
  client.toPage.set(hostId, pageId);
  client.toHost.set(pageId, hostId);
}

function swapIds(sdp: string | undefined, map: Map<string, string>): string | undefined {
  if (!sdp || !map.size) return sdp;
  let result = sdp;
  for (const [from, to] of map) result = result.split(from).join(to);
  return result;
}

const describe = (
  value: RTCSessionDescription | RTCSessionDescriptionInit | null,
  client?: Client,
) =>
  value ? { type: value.type, sdp: client ? swapIds(value.sdp, client.toPage) : value.sdp } : null;

function sanitizeConfig(config: RTCConfigurationLike | undefined): RTCConfiguration {
  const result: Record<string, unknown> = {};
  if (Array.isArray(config?.iceServers)) {
    result.iceServers = config.iceServers.map((server) => {
      const entry: Record<string, unknown> = { urls: server.urls ?? server.url };
      if (server.username !== undefined) entry.username = String(server.username);
      if (server.credential !== undefined) entry.credential = String(server.credential);
      return entry;
    });
  }
  for (const name of [
    'iceTransportPolicy',
    'bundlePolicy',
    'rtcpMuxPolicy',
    'iceCandidatePoolSize',
  ])
    if (config?.[name] !== undefined) result[name] = config[name];
  return result as RTCConfiguration;
}

/**
 * WebRTC of the pages (polyfill in engine WebRTCPolyfill.cpp): every RTCPeerConnection and
 * RTCDataChannel of a page has a real counterpart in the host browser. Events are queued per
 * page (client) and fetched with "rtc-poll". The connections use the network of the host, not
 * the transport: the remote side sees the IP address of the device.
 */
export class WebRTCService extends Service {
  readonly features = ['webrtc'] as const;

  constructor() {
    super('webrtc');
  }

  setup(ctx: ServiceContext): void {
    const clients = new Map<string, Client>();

    const clientFor = (id: unknown, origin: string, create: boolean): Client => {
      if (typeof id !== 'string' || !id) throw domError('InvalidAccessError', 'Missing client');
      let client = clients.get(id);
      if (!client) {
        if (!create) throw domError('InvalidStateError', 'Unknown connection');
        client = {
          origin,
          pcs: new Map(),
          channels: new Map(),
          channelPc: new Map(),
          queue: [],
          waiter: null,
          lastSeen: Date.now(),
          remoteChannels: 0,
          transceivers: new Map(),
          transceiverKeys: new WeakMap(),
          transceiverPc: new Map(),
          remoteTransceivers: 0,
          tracks: new Map(),
          streams: new Map(),
          toPage: new Map(),
          toHost: new Map(),
        };
        clients.set(id, client);
      }
      // Connections belong to the origin that made them
      if (client.origin !== origin) throw domError('SecurityError', 'Wrong origin');
      client.lastSeen = Date.now();
      return client;
    };

    const push = (client: Client, event: unknown) => {
      client.queue.push(event);
      const wake = client.waiter;
      client.waiter = null;
      wake?.();
    };

    // Snapshots arrive through different answers (operation, event); the sequence number
    // tells the page which one is newer
    const transceiverKey = (client: Client, pcId: string, transceiver: RTCRtpTransceiver) => {
      let key = client.transceiverKeys.get(transceiver);
      if (!key) {
        key = `r${++client.remoteTransceivers}`;
        remember(client, pcId, key, transceiver);
      }
      return key;
    };

    const remember = (
      client: Client,
      pcId: string,
      key: string,
      transceiver: RTCRtpTransceiver,
    ) => {
      client.transceivers.set(key, transceiver);
      client.transceiverKeys.set(transceiver, key);
      client.transceiverPc.set(key, pcId);
    };

    const snapshot = (
      pc: RTCPeerConnection & { blSequence?: number },
      client: Client,
      pcId: string,
    ) => {
      pc.blSequence = (pc.blSequence || 0) + 1;
      return {
        sequence: pc.blSequence,
        transceivers: pc.getTransceivers().map((transceiver) => ({
          key: transceiverKey(client, pcId, transceiver),
          kind: transceiver.receiver.track.kind,
          mid: transceiver.mid,
          direction: transceiver.direction,
          currentDirection: transceiver.currentDirection,
          sender: json(transceiver.sender.getParameters()),
          receiver: json(transceiver.receiver.getParameters()),
        })),
        signalingState: pc.signalingState,
        iceGatheringState: pc.iceGatheringState,
        iceConnectionState: pc.iceConnectionState,
        connectionState: pc.connectionState,
        canTrickleIceCandidates: pc.canTrickleIceCandidates ?? null,
        localDescription: describe(pc.localDescription, client),
        currentLocalDescription: describe(pc.currentLocalDescription, client),
        pendingLocalDescription: describe(pc.pendingLocalDescription, client),
        remoteDescription: describe(pc.remoteDescription, client),
        currentRemoteDescription: describe(pc.currentRemoteDescription, client),
        pendingRemoteDescription: describe(pc.pendingRemoteDescription, client),
      };
    };

    const channelInfo = (key: string, channel: RTCDataChannel) => ({
      key,
      label: channel.label,
      ordered: channel.ordered,
      maxPacketLifeTime: channel.maxPacketLifeTime,
      maxRetransmits: channel.maxRetransmits,
      protocol: channel.protocol,
      negotiated: channel.negotiated,
      id: channel.id,
      readyState: channel.readyState,
    });

    const wireChannel = (client: Client, pcId: string, key: string, channel: RTCDataChannel) => {
      channel.binaryType = 'arraybuffer';
      client.channels.set(key, channel);
      client.channelPc.set(key, pcId);
      channel.onopen = () => push(client, { channel: key, type: 'open', id: channel.id });
      channel.onmessage = (event) => {
        if (typeof event.data === 'string')
          push(client, { channel: key, type: 'message', text: event.data });
        else
          push(client, {
            channel: key,
            type: 'message',
            binary: bytesToBase64(new Uint8Array(event.data)),
          });
      };
      channel.onbufferedamountlow = () => push(client, { channel: key, type: 'bufferedamountlow' });
      channel.onerror = (event) => {
        const error = (event as RTCErrorEvent).error;
        push(client, {
          channel: key,
          type: 'error',
          errorDetail: error?.errorDetail,
          message: error?.message,
        });
      };
      channel.onclosing = () => push(client, { channel: key, type: 'closing' });
      channel.onclose = () => {
        push(client, { channel: key, type: 'close' });
        client.channels.delete(key);
        client.channelPc.delete(key);
      };
    };

    // Page track -> host track. Camera/microphone: a clone of the real track; otherwise a
    // MediaStreamTrackGenerator the engine worker writes into
    const hostTrack = async (client: Client, info: TrackInfo | undefined) => {
      if (!info) return null;
      let track = client.tracks.get(info.id);
      if (track && track.readyState !== 'ended') return track;
      const Generator = trackGenerator();
      if (info.capture) {
        const original = await ctx.use<CaptureApi>('capture')?.track(info.capture);
        if (!original) throw domError('InvalidStateError', 'The track has ended.');
        track = original.clone();
      } else if (info.sink && Generator) {
        const worker = ctx.engineWorker();
        if (!worker) throw domError('InvalidStateError', 'No engine');
        const generator = new Generator({ kind: info.kind });
        worker.postMessage({ blSink: { id: info.sink, writable: generator.writable } }, [
          generator.writable,
        ]);
        track = generator;
      } else throw domError('NotSupportedError', 'This track cannot be sent');
      track.enabled = info.enabled !== false;
      client.tracks.set(info.id, track);
      mapId(client, track.id, info.id);
      return track;
    };

    const streamsFor = (client: Client, ids: string[] | undefined) =>
      (ids || []).map((id) => {
        let stream = client.streams.get(id);
        if (!stream) {
          stream = new MediaStream();
          client.streams.set(id, stream);
          mapId(client, stream.id, id);
        }
        return stream;
      });

    const transceiverFor = (client: Client, key: string | undefined) => {
      const transceiver = key ? client.transceivers.get(key) : undefined;
      if (!transceiver) throw domError('InvalidStateError', 'Unknown transceiver');
      return transceiver;
    };

    const connection = (client: Client, id: string | undefined) => {
      const pc = id ? client.pcs.get(id) : undefined;
      if (!pc) throw domError('InvalidStateError', 'The RTCPeerConnection is closed.');
      return pc;
    };

    const closeConnection = (client: Client, id: string | undefined) => {
      const pc = id ? client.pcs.get(id) : undefined;
      if (!pc || !id) return;
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
      // Stop host tracks no open connection sends any more (frees the camera clone, closes the
      // generator); the next addTrack makes new ones
      const used = new Set<MediaStreamTrack>();
      for (const other of client.pcs.values())
        for (const sender of other.getSenders()) if (sender.track) used.add(sender.track);
      for (const [pageId, track] of client.tracks) {
        if (!used.has(track)) {
          track.stop();
          client.tracks.delete(pageId);
        }
      }
      try {
        pc.close();
      } catch {}
    };

    const closeClient = (id: string) => {
      const client = clients.get(id);
      if (!client) return;
      clients.delete(id);
      for (const pcId of [...client.pcs.keys()]) closeConnection(client, pcId);
      for (const track of client.tracks.values()) track.stop();
      client.tracks.clear();
      client.waiter?.();
    };

    // Pages that stopped asking (view closed, crash) are cleaned up
    const timer = setInterval(() => {
      const now = Date.now();
      for (const [id, client] of clients)
        if (!client.waiter && now - client.lastSeen > CLIENT_TIMEOUT) closeClient(id);
    }, CLIENT_TIMEOUT / 2);
    ctx.signal.addEventListener('abort', () => {
      clearInterval(timer);
      for (const id of [...clients.keys()]) closeClient(id);
    });

    const operations: Record<string, Operation> = {
      async createOffer(pc, payload, client) {
        return { description: describe(await pc.createOffer(payload.options || {}), client) };
      },
      async createAnswer(pc, payload, client) {
        return { description: describe(await pc.createAnswer(payload.options || {}), client) };
      },
      async setLocalDescription(pc, payload, client) {
        const description = payload.description && {
          type: payload.description.type,
          sdp: swapIds(payload.description.sdp, client.toHost),
        };
        await (description ? pc.setLocalDescription(description) : pc.setLocalDescription());
        return {};
      },
      async setRemoteDescription(pc, payload) {
        await pc.setRemoteDescription(payload.description as RTCSessionDescriptionInit);
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
        const channel = pc.createDataChannel(
          String(payload.label ?? ''),
          (payload.init || {}) as RTCDataChannelInit,
        );
        wireChannel(client, payload.pc as string, payload.channel, channel);
        return { id: channel.id };
      },
      async addTrack(pc, payload, client) {
        const track = await hostTrack(client, payload.track);
        const streams = streamsFor(client, payload.streams);
        if (payload.reuse) {
          // Like addTrack with an unused transceiver from an offer
          const transceiver = transceiverFor(client, payload.transceiver);
          await transceiver.sender.replaceTrack(track);
          transceiver.sender.setStreams?.(...streams);
          transceiver.direction =
            transceiver.direction === 'recvonly'
              ? 'sendrecv'
              : transceiver.direction === 'inactive'
                ? 'sendonly'
                : transceiver.direction;
        } else {
          if (!track) throw domError('TypeError', 'Missing track');
          const transceiver = pc.addTransceiver(track, { direction: 'sendrecv', streams });
          remember(client, payload.pc as string, payload.transceiver as string, transceiver);
        }
        return {};
      },
      async addTransceiver(pc, payload, client) {
        const init: RTCRtpTransceiverInit = {
          direction: (payload.init?.direction as RTCRtpTransceiverDirection) ?? 'sendrecv',
          streams: streamsFor(client, payload.init?.streams as string[] | undefined),
        };
        if (payload.init?.sendEncodings)
          init.sendEncodings = payload.init.sendEncodings as RTCRtpEncodingParameters[];
        const track = payload.track ? await hostTrack(client, payload.track) : null;
        const transceiver = pc.addTransceiver(track ?? (payload.kind as string), init);
        remember(client, payload.pc as string, payload.transceiver as string, transceiver);
        return {};
      },
      async removeTrack(pc, payload, client) {
        pc.removeTrack(transceiverFor(client, payload.transceiver).sender);
        return {};
      },
      async replaceTrack(_pc, payload, client) {
        await transceiverFor(client, payload.transceiver).sender.replaceTrack(
          await hostTrack(client, payload.track),
        );
        return {};
      },
      async setStreams(_pc, payload, client) {
        transceiverFor(client, payload.transceiver).sender.setStreams?.(
          ...streamsFor(client, payload.streams),
        );
        return {};
      },
      async setParameters(_pc, payload, client) {
        await transceiverFor(client, payload.transceiver).sender.setParameters(
          payload.parameters as RTCRtpSendParameters,
        );
        return {};
      },
      async setDirection(_pc, payload, client) {
        transceiverFor(client, payload.transceiver).direction =
          payload.direction as RTCRtpTransceiverDirection;
        return {};
      },
      async stopTransceiver(_pc, payload, client) {
        transceiverFor(client, payload.transceiver).stop();
        return {};
      },
      async setCodecPreferences(_pc, payload, client) {
        transceiverFor(client, payload.transceiver).setCodecPreferences(payload.codecs || []);
        return {};
      },
      async getStats(pc, payload, client) {
        let source: { getStats(): Promise<RTCStatsReport> } = pc;
        if (payload.selector?.sender)
          source = transceiverFor(client, payload.selector.sender).sender;
        else if (payload.selector?.receiver)
          source = transceiverFor(client, payload.selector.receiver).receiver;
        const report = await source.getStats();
        return { stats: [...report.values()].map((entry) => json(entry)) };
      },
    };

    ctx.hostCall<Payload | null>('rtc-create', async (payload, origin) => {
      if (typeof RTCPeerConnection !== 'function')
        throw domError('NotSupportedError', 'WebRTC is not available');
      const client = clientFor(payload?.client, origin, true);
      // The polyfill numbers its connections: the id is used as it comes, like in every lookup
      const id = payload?.pc;
      if ((typeof id !== 'string' && typeof id !== 'number') || client.pcs.has(id))
        throw domError('InvalidStateError', 'Duplicate connection');
      const pc: RTCPeerConnection & { blSequence?: number } = new RTCPeerConnection(
        sanitizeConfig(payload?.config),
      );
      client.pcs.set(id, pc);
      const forward = (type: string) => () =>
        push(client, { pc: id, type, state: snapshot(pc, client, id) });
      pc.onicecandidate = (event) =>
        push(client, {
          pc: id,
          type: 'icecandidate',
          candidate: event.candidate ? event.candidate.toJSON() : null,
          url: (event as RTCPeerConnectionIceEvent & { url?: string }).url ?? null,
          state: snapshot(pc, client, id),
        });
      pc.onicecandidateerror = (event) =>
        push(client, {
          pc: id,
          type: 'icecandidateerror',
          address: event.address,
          port: event.port,
          url: event.url,
          errorCode: event.errorCode,
          errorText: event.errorText,
          state: snapshot(pc, client, id),
        });
      for (const type of [
        'negotiationneeded',
        'signalingstatechange',
        'iceconnectionstatechange',
        'icegatheringstatechange',
        'connectionstatechange',
      ])
        pc.addEventListener(type, forward(type));
      pc.ontrack = (event) => {
        const key = transceiverKey(client, id, event.transceiver);
        push(client, {
          pc: id,
          type: 'track',
          transceiver: key,
          streams: event.streams.map((stream) => stream.id),
          state: snapshot(pc, client, id),
        });
      };
      pc.ondatachannel = (event) => {
        const key = `${payload?.client}:r${++client.remoteChannels}`;
        wireChannel(client, id, key, event.channel);
        push(client, {
          pc: id,
          type: 'datachannel',
          info: channelInfo(key, event.channel),
          state: snapshot(pc, client, id),
        });
      };
      const capabilities: Record<string, Record<string, unknown>> = { sender: {}, receiver: {} };
      for (const kind of ['audio', 'video']) {
        (capabilities.sender as Record<string, unknown>)[kind] = json(
          RTCRtpSender.getCapabilities?.(kind),
        );
        (capabilities.receiver as Record<string, unknown>)[kind] = json(
          RTCRtpReceiver.getCapabilities?.(kind),
        );
      }
      return { state: snapshot(pc, client, id), capabilities };
    });

    ctx.hostCall<Payload | null>('rtc-op', async (payload, origin) => {
      const client = clientFor(payload?.client, origin, false);
      const pc = connection(client, payload?.pc);
      const operation = payload?.op ? operations[payload.op] : undefined;
      if (!operation || !payload) throw domError('NotSupportedError', 'Unknown operation');
      const result = await operation(pc, payload, client);
      return { ...result, state: snapshot(pc, client, payload.pc as string) };
    });

    ctx.hostCall<Payload | null>('rtc-poll', async (payload, origin) => {
      const client = clientFor(payload?.client, origin, true);
      if (!client.queue.length) {
        await new Promise<void>((resolve) => {
          client.waiter = resolve;
          setTimeout(() => {
            if (client.waiter === resolve) client.waiter = null;
            resolve();
          }, POLL_WAIT);
        });
      }
      client.lastSeen = Date.now();
      return client.queue.splice(0);
    });

    // The page shows the track of a receiver: frames and sound go to the engine
    ctx.hostCall<Payload | null>('rtc-receive', async (payload, origin) => {
      const client = clientFor(payload?.client, origin, false);
      const track = transceiverFor(client, payload?.transceiver).receiver.track;
      const worker = ctx.engineWorker();
      const Processor = trackProcessor();
      if (!worker || !Processor)
        throw domError('NotSupportedError', 'MediaStreamTrackProcessor is missing');
      const source = Number(payload?.source);
      const processor = new Processor({ track });
      worker.postMessage(
        { blCapture: { id: source, kind: track.kind, readable: processor.readable } },
        [processor.readable],
      );
      // Chrome pulls WebRTC audio only when it plays somewhere: a muted <audio> keeps it
      // running (the engine makes it audible)
      let player: HTMLAudioElement | null = null;
      if (track.kind === 'audio') {
        player = new Audio();
        player.muted = true;
        player.srcObject = new MediaStream([track]);
        player.play().catch(() => {});
      }
      const muted = (value: boolean) => {
        if (!ctx.signal.aborted) ctx.module._bl_remote_muted(source, value ? 1 : 0);
      };
      if (track.muted) muted(true);
      track.addEventListener('mute', () => muted(true));
      track.addEventListener('unmute', () => muted(false));
      track.addEventListener(
        'ended',
        () => {
          if (player) player.srcObject = null;
          if (!ctx.signal.aborted) ctx.module._bl_capture_ended(source);
        },
        { once: true },
      );
      return {};
    });

    ctx.hostCall<Payload | null>('rtc-track', async (payload, origin) => {
      const client = clientFor(payload?.client, origin, false);
      const id = payload?.track as unknown as string;
      const track = client.tracks.get(id);
      if (!track) return {};
      if (payload?.stop) {
        track.stop();
        client.tracks.delete(id);
      } else if (typeof payload?.enabled === 'boolean') track.enabled = payload.enabled;
      return {};
    });

    ctx.hostCall<Payload | null>('rtc-send', async (payload, origin) => {
      const client = clientFor(payload?.client, origin, false);
      const channel = payload?.channel ? client.channels.get(payload.channel) : undefined;
      if (channel?.readyState !== 'open')
        throw domError('InvalidStateError', "RTCDataChannel.readyState is not 'open'");
      if (payload?.binary !== undefined) channel.send(base64ToBytes(payload.binary));
      else channel.send(String(payload?.text ?? ''));
      return { bufferedAmount: channel.bufferedAmount };
    });

    ctx.hostCall<Payload | null>('rtc-channel', async (payload, origin) => {
      const client = clientFor(payload?.client, origin, false);
      const channel = payload?.channel ? client.channels.get(payload.channel) : undefined;
      if (channel && typeof payload?.threshold === 'number')
        channel.bufferedAmountLowThreshold = payload.threshold;
      return {};
    });

    ctx.hostCall<Payload | null>('rtc-channel-close', async (payload, origin) => {
      const client = clientFor(payload?.client, origin, false);
      if (payload?.channel) client.channels.get(payload.channel)?.close();
      return {};
    });

    ctx.hostCall<Payload | null>('rtc-close', async (payload, origin) => {
      closeConnection(clientFor(payload?.client, origin, false), payload?.pc);
      return {};
    });

    ctx.hostCall<Payload | null>('rtc-close-all', async (payload, origin) => {
      clientFor(payload?.client, origin, false);
      closeClient(payload?.client as string);
      return {};
    });

    ctx.debugState('rtc', () =>
      [...clients.values()].map((client) => ({
        pcs: [...client.pcs.values()].map((pc) => `${pc.iceGatheringState}/${pc.signalingState}`),
        queue: client.queue.length,
        waiting: !!client.waiter,
      })),
    );
  }
}
