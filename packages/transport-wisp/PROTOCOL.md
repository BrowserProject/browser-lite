# Wisp v1 as used by browser-lite

This is the protocol between `WispTransport` (client) and the relay of `@browser-lite/server`.
It is Wisp v1 ([wisp-protocol](https://github.com/MercuryWorkshop/wisp-protocol)) with a few
extras marked as such. Both sides follow this document; the server is the reference for other
clients and the client works with other Wisp v1 servers (without the extras).

## Transport

One WebSocket per client, binary messages only. Each message is exactly one packet. A client with
a token offers the subprotocols `wisp` and `bl-token.<token as base64url without padding>`
(extra: never in the URL, which ends up in proxy logs); the server answers with `wisp` and never
echoes the token. Non-browser clients may send `Authorization: Bearer <token>` instead. A refused
upgrade is an HTTP status: 403 (token, origin or host name), 429 (too many connections from one
client address), 503 (relay shutting down).

## Packets

All integers little endian.

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 1 | type |
| 1 | 4 | stream id |
| 5 | rest | payload |

| Type | Name | Payload |
| --- | --- | --- |
| 0x01 | CONNECT | stream type (u8, 0x01 TCP), port (u16), host name (UTF-8, rest) |
| 0x02 | DATA | bytes |
| 0x03 | CONTINUE | buffer remaining (u32): packets the client may still send on the stream |
| 0x04 | CLOSE | reason (u8) |

Stream id 0 belongs to the connection, streams use ids from 1. The client picks the ids and never
reuses one on the same WebSocket.

## Flow

1. After the upgrade the server sends CONTINUE on stream 0 with its buffer size (128). The client
   waits for it (at most 15 s) before it sends anything.
2. The client sends CONNECT and may then send DATA right away; Wisp does not confirm a stream.
   Each new stream starts with the buffer size as credit, each DATA packet costs one credit. The
   client splits writes into DATA packets of at most 64 KiB.
3. The server writes DATA to the target. After every 64 packets handed to the operating system it
   sends CONTINUE with the remaining buffer (128 minus packets not yet written). A target that
   does not read thus stops the client. The client sets its credit to the received value.
4. Data from the target comes as DATA. The server reads from targets only while the WebSocket
   send buffer is below 8 MiB.
5. Either side ends a stream with CLOSE. The other side does not answer. When the client closes,
   the server still delivers what the client sent, then drops the target socket; data still
   arriving from the target is discarded.

## Close reasons

| Code | Meaning | Client reason |
| --- | --- | --- |
| 0x02 | closed normally (target closed, or client closed) | `closed` |
| 0x01, 0x03 | unspecified error, network error (also: client ignored flow control) | `reset` |
| 0x41 | invalid connect info (empty host, port 0, malformed CONNECT, invalid host name) | `invalid` |
| 0x42 | host name not resolved | `name-not-resolved` |
| 0x43 | target did not answer | `timeout` |
| 0x44 | connection refused | `refused` |
| 0x47 | timeout (also: stream idle longer than the policy allows) | `timeout` |
| 0x48 | blocked by policy (address, port, stream type) | `blocked` |
| 0x49 | throttled (too many streams on the connection or to the same target) | `throttled` |
| 0x4a | address resolved but not reachable (extra, not in Wisp) | `unreachable` |
| other | | `reset` |

When the WebSocket is lost, every stream of the client ends with `transport-down`. A stream that
ends before `onopen` was never sent to a relay (no connection).

## Extras of browser-lite

- **Keepalive**: while streams are open and the server sent nothing for 3 s, it sends CONTINUE on
  stream 0 (buffer remaining 128). The client only counts it as a sign of life. It shows the
  client that the relay is alive even while its own upload sits in buffers it cannot see.
- **Probe**: Wisp has no ping. If nothing arrives for 10 s after the client sent something and its
  WebSocket buffer is empty, the client sends CONNECT with an empty host and port 0 on a fresh
  stream id. The server answers at once with CLOSE 0x41, before any other check and without
  logging. Without an answer within 5 s the client drops the WebSocket and reconnects. While the
  WebSocket buffer drains the connection counts as alive; if it does not drain for 10 s, it is
  dead.
- **Reason 0x4a** (see above).
- **Reconnect**: a dropped WebSocket is replaced at once once; if that fails the client is offline
  (`connected` false) and retries every 2 s until it succeeds or is closed. The token is fetched
  again for every connect.

## Server rules

- Only TCP streams; other stream types are closed with 0x48.
- Ports and addresses from the policy. By default only ports 80, 443, 8080, 8443 and only global
  unicast addresses (IPv4-mapped IPv6 is converted to IPv4 first). The server resolves the name
  itself and connects only to the addresses it checked, IPv6 and IPv4 interleaved, so DNS
  rebinding cannot slip a private address in between.
- At most 256 streams per WebSocket, 64 of them to the same target (host name lower case without
  trailing dot, and port). Beyond that: 0x49. A stream the client closed counts until the server
  has written what the client sent and closed the socket (at most 10 s).
- Client data the target has not taken yet: at most 512 packets and 2 * 128 packets of the size
  limit per stream, at least 32 MiB per WebSocket (closed streams included). Beyond that the
  stream is closed with 0x03.
- A stream closed by the client while its name is still being resolved is never connected.
- Protocol errors close the WebSocket: text messages (1003), packets shorter than 5 bytes or a
  CONNECT on stream 0 or on an open stream id (1002), messages above the size limit (1009,
  default 64 KiB plus the 5 byte header, the largest packet of `WispTransport`). DATA and CLOSE for unknown streams, CONTINUE from the client and unknown packet
  types are ignored.
- The server pings the WebSocket every 30 s and drops a client that missed a pong.
- Stream contents are never logged.
