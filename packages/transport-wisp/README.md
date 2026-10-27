# @browser-lite/transport-wisp

The network of the browser-lite engine over a Wisp v1 relay: every TCP connection of the engine
becomes a stream over one of a few WebSockets. TLS happens inside the engine, the relay only sees
encrypted bytes. Protocol and server rules: [PROTOCOL.md](PROTOCOL.md). The matching server is
`createRelay` of [@browser-lite/server](../server/README.md).

## Install

Not on npm yet: install the tarballs of a GitHub release together with `@browser-lite/core`
([README, Install](../../README.md#install)).

## Example

```ts
import { createBrowser } from '@browser-lite/core';
import { WispTransport } from '@browser-lite/transport-wisp';

const transport = new WispTransport({
  // Relative URLs resolve against location, http(s) stands for ws(s)
  url: '/wisp/',
  // Static token, or a function that fetches a fresh signed token for every connect
  token: async () => (await fetch('/relay-token')).text(),
});
transport.addEventListener('connectedchange', () => console.log('online', transport.connected));
const browser = await createBrowser({ engineUrl: '/engine/0.1.0/', transport });
```

## API

`new WispTransport({ url, token?, connections? })` implements `Transport` of `@browser-lite/core`.
`url` may be relative (resolved against `location`) and `ws:`, `wss:`, `http:` or `https:`, else
TypeError. `connections` (1 to 8, default 3) is the number of WebSockets; a new stream goes to the
connected one with the fewest streams. With packet loss one TCP connection carries only a part of
the link, several together come close to what a browser gets with its own connections; each counts
against `connectionsPerIp` of the relay (16 by default).
The token goes as the WebSocket subprotocol `bl-token.<base64url>` next to `wisp`, never in the
URL ([PROTOCOL.md](PROTOCOL.md)).

| Member | |
| --- | --- |
| `connected` | false while the relay cannot be reached; event `connectedchange` on every change |
| `openTCP(host, port)` | a `TransportStream`; `onclose` gets a `CloseReason` |
| `preconnect()` | opens the WebSockets now (`createBrowser` calls it while the engine loads) |
| `close()` | closes all streams (`transport-down`) and stops reconnecting |

Behaviour:

- The WebSockets open with `preconnect()` or the first streams. After that each one always
  reconnects: a dropped connection is replaced at once, otherwise it retries every 2 s.
  `connected` is true while one WebSocket is.
- Flow control by Wisp credit; `onsent` reports bytes that left the transport (backpressure for
  the engine's sockets).
- Acknowledges what arrived, so a relay of `@browser-lite/server` keeps only about two round
  trips of data on the way and a small response does not queue behind large downloads
  ([PROTOCOL.md](PROTOCOL.md)); other Wisp servers ignore it.
- Dead connections (sleep, network change, `online` event of the page) are detected with a probe
  and replaced.
- Uses the `WebSocket` of `globalThis` at construction time.
