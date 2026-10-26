/** Options of {@link WispTransport}. */
export interface WispTransportOptions {
  /**
   * WebSocket URL of the relay, for example `wss://example.org/wisp/`. Relative URLs resolve
   * against `location`; `http:` and `https:` stand for `ws:` and `wss:`.
   */
  url: string | URL;
  /**
   * Token for the relay, sent on every (re)connect as the WebSocket subprotocol
   * `bl-token.<base64url of the token>` next to `wisp` (never in the URL, which ends up in proxy
   * logs). A function is called for each connect, so it can fetch a fresh signed token.
   */
  token?: string | (() => string | Promise<string>);
  /**
   * WebSockets to the relay, 1 to 8, default 3. Each is its own TCP connection: with packet loss
   * one connection carries only a fraction of the link (its congestion window keeps shrinking),
   * so the streams are spread over several, like a browser uses several connections. Each one
   * counts against `connectionsPerIp` of the relay.
   */
  connections?: number;
}

/** Why a {@link WispTransport} dispatched `error`. */
export type WispErrorReason = 'unauthorized';

/**
 * Event `error` of a {@link WispTransport}: 'unauthorized' when the relay refused the token
 * (WebSocket close code 4401 or 4403). The transport keeps retrying with growing delays and
 * asks the token function again for every attempt.
 */
export class WispErrorEvent extends Event {
  constructor(readonly reason: WispErrorReason) {
    super('error');
  }
}
