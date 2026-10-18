import type { EngineOptions } from '@browser-lite/core';
import { storage } from './util.js';

const params = new URLSearchParams(location.search);

/** `?debug=1`: browser.debug, engine test hooks, window.blTest, `?relay=` and `?env=`. */
export const debug = params.get('debug') === '1';

/** `?url=`: opened instead of the last session. */
export const startUrl = params.get('url');

/** localStorage key of the access token for the server at `host` (relay and profile). */
const tokenKey = (host: string) => `bl-relay-token ${host}`;

/** Access token for the server at `host`, null without one. */
export const tokenFor = (host: string): string | null => storage(tokenKey(host));

/**
 * Relay of this page: `/wisp/` of the own server. `?relay=` (only with `?debug=1`) takes another
 * one for this load only; it is never stored, so a link cannot redirect the traffic for good.
 */
export const relayUrl = new URL(
  (debug && params.get('relay')) || '/wisp/',
  `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/`,
);

// `?token=` belongs to exactly the relay it came with: another relay never sees it
const token = params.get('token');
if (token) storage(tokenKey(relayUrl.host), token);

/**
 * Engine options from the URL: `?log=1`, `?gpu=0`, `?compositing=0`, `?safepointgc=0|debug`,
 * `?httpcache=0`, `?scripttimeout=<seconds>`, `?fcdebug=<level>` and, only with `?debug=1`,
 * `?env=KEY=value,...` as `engine.env` (createBrowser rejects switches the core owns).
 */
export function engineOptions(): EngineOptions {
  const engine: EngineOptions = {};
  const env: Record<string, string> = {};
  if (debug) {
    for (const pair of (params.get('env') ?? '').split(',')) {
      const at = pair.indexOf('=');
      if (at > 0) env[pair.slice(0, at)] = pair.slice(at + 1);
    }
  }
  const flag = (name: string) => params.get(name);
  if (flag('log')) engine.log = flag('log') !== '0';
  if (flag('gpu')) engine.gpu = flag('gpu') !== '0';
  if (flag('compositing')) engine.compositing = flag('compositing') !== '0';
  const safepoint = flag('safepointgc');
  if (safepoint) engine.safepointGC = safepoint === 'debug' ? 'debug' : safepoint !== '0';
  if (flag('httpcache') === '0') engine.httpCache = false;
  const timeout = flag('scripttimeout');
  if (timeout) engine.scriptTimeoutSeconds = Number(timeout);
  const fcdebug = flag('fcdebug');
  if (fcdebug) env.FC_DEBUG = fcdebug;
  if (Object.keys(env).length) engine.env = env;
  return engine;
}
