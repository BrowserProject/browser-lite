# @browser-lite/transport-wisp

The network of the browser-lite engine over a Wisp v1 relay: every TCP connection of the engine
becomes a stream over one WebSocket. TLS happens inside the engine, the relay only sees
encrypted bytes. Protocol and server rules: [PROTOCOL.md](PROTOCOL.md). The matching server is
`createRelay` of [@browser-lite/server](../server/README.md).

## Install

```bash
npm install @browser-lite/core @browser-lite/transport-wisp
```

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
const browser = await createBrowser({ engineUrl: '/engine/', transport });
```

## API

`new WispTransport({ url, token? })` implements `Transport` of `@browser-lite/core`. `url` may be
relative (resolved against `location`) and `ws:`, `wss:`, `http:` or `https:`, else TypeError.
The token goes as the WebSocket subprotocol `bl-token.<base64url>` next to `wisp`, never in the
URL ([PROTOCOL.md](PROTOCOL.md)).

| Member | |
| --- | --- |
| `connected` | false while the relay cannot be reached; event `connectedchange` on every change |
| `openTCP(host, port)` | a `TransportStream`; `onclose` gets a `CloseReason` |
| `close()` | closes all streams (`transport-down`) and stops reconnecting |

Behaviour:

- The WebSocket opens with the first stream. After that the transport always reconnects: a
  dropped connection is replaced at once, otherwise it retries every 2 s.
- Flow control by Wisp credit; `onsent` reports bytes that left the transport (backpressure for
  the engine's sockets).
- Dead connections (sleep, network change, `online` event of the page) are detected with a probe
  and replaced.
- Uses the `WebSocket` of `globalThis` at construction time.
