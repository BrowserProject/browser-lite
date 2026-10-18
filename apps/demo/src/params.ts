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

// Expert switches that map to typed options of the core
const TYPED_ENV: Record<string, (value: string, engine: EngineOptions) => void> = {
  BL_DEBUG: (value, engine) => {
    engine.log = value !== '0';
  },
  BL_GPU: (value, engine) => {
    engine.gpu = value !== '0';
  },
  BL_COMPOSITING: (value, engine) => {
    engine.compositing = value !== '0';
  },
  BL_SAFEPOINT_GC: (value, engine) => {
    engine.safepointGC = value === 'debug' ? 'debug' : value !== '0';
  },
  BL_HTTP_CACHE: (value, engine) => {
    engine.httpCache = value !== '0';
  },
  BL_SCRIPT_TIMEOUT: (value, engine) => {
    const seconds = Number(value);
    if (seconds >= 0) engine.scriptTimeoutSeconds = seconds;
  },
};
// Set by the core from other options; a link never sets them (BL_EXTRA_CA only by code)
const IGNORED_ENV = new Set([
  'BL_EXTRA_CA',
  'BL_TEST_HOOKS',
  'BL_FEATURES',
  'BL_STORAGE_NAMESPACE',
  'BL_OPFS',
  'BL_ERROR_PAGE',
  'BL_KEEP_SESSION_COOKIES',
  'BL_BYTECODE_CACHE',
]);

/**
 * Engine options from the URL: `?log=1`, `?gpu=0`, `?compositing=0`, `?safepointgc=0|debug`,
 * `?httpcache=0`, `?fcdebug=<level>` and, only with `?debug=1`, `?env=KEY=value,...` (only
 * `BL_*`, `JSC_*` and `FC_*` switches of the engine).
 */
export function engineOptions(): EngineOptions {
  const engine: EngineOptions = {};
  const env: Record<string, string> = {};
  if (debug) {
    for (const pair of (params.get('env') ?? '').split(',')) {
      const at = pair.indexOf('=');
      const key = pair.slice(0, at);
      const value = pair.slice(at + 1);
      if (at <= 0 || !/^(BL|JSC|FC)_[A-Za-z0-9_]+$/.test(key) || IGNORED_ENV.has(key)) continue;
      const typed = TYPED_ENV[key];
      if (typed) typed(value, engine);
      else env[key] = value;
    }
  }
  const flag = (name: string) => params.get(name);
  if (flag('log')) engine.log = flag('log') !== '0';
  if (flag('gpu')) engine.gpu = flag('gpu') !== '0';
  if (flag('compositing')) engine.compositing = flag('compositing') !== '0';
  const safepoint = flag('safepointgc');
  if (safepoint) engine.safepointGC = safepoint === 'debug' ? 'debug' : safepoint !== '0';
  if (flag('httpcache') === '0') engine.httpCache = false;
  const fcdebug = flag('fcdebug');
  if (fcdebug) env.FC_DEBUG = fcdebug;
  if (Object.keys(env).length) engine.env = env;
  return engine;
}
