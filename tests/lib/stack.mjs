// The servers of a browser test: the page under test (core test host page or demo) and the relay,
// both browser-lite-server on free ports. The relay is another origin than the page, like on a
// real server it only accepts that page as origin.
import fs from 'node:fs';
import { VERBOSE, engineDir } from './env.mjs';
import { startServer, stopProcess, tempDir } from './processes.mjs';
import { coreSite, demoSite } from './site.mjs';

/**
 * Starts page server and relay. app 'core': tests/core/host, app 'demo': apps/demo with the
 * browser profile on the server in a new empty folder (stack.profileDir). allowLocal lets the
 * relay reach local addresses (the test servers); without it, it runs like on the server.
 * A second device is a second Chromium context at the same stack.
 */
export async function startStack({
  app = 'core',
  token = '',
  allowLocal = true,
  engine = engineDir,
} = {}) {
  const demo = app === 'demo';
  const profileDir = demo ? tempDir('server-profile') : null;
  const site = demo ? demoSite(engine) : coreSite(engine);
  if (!fs.existsSync(site)) throw new Error(`site folder ${site} missing`);
  const page = await startServer({
    SITE_DIR: site,
    ...(profileDir ? { PROFILE_DIR: profileDir } : {}),
  });
  const origin = `http://localhost:${page.port}`;
  const relayEnv = {
    RELAY_TOKEN: token,
    RELAY_ALLOWED_ORIGINS: origin,
    ...(allowLocal ? { RELAY_ALLOW_LOCAL: '1' } : {}),
  };
  const relay = await startServer(relayEnv);
  const stack = {
    app,
    token,
    profileDir,
    origin,
    pageServer: page.child,
    relay: relay.child,
    relayPort: relay.port,
    relayURL: `ws://127.0.0.1:${relay.port}/wisp/`,
    /**
     * Address of the page with this relay and token and more parameters (url, env, log, ...).
     * The demo gets debug=1 (window.blTest, browser.debug, engine test hooks; ?relay= needs it).
     */
    app(params = {}) {
      const query = new URLSearchParams({
        relay: stack.relayURL,
        ...(token ? { token } : {}),
        ...(demo ? { debug: '1' } : {}),
        ...(VERBOSE ? { log: '1' } : {}),
        ...params,
      });
      return `${origin}/?${query}`;
    },
    /** Ends the relay (connections drop) without a new one. */
    async stopRelay() {
      await stopProcess(stack.relay);
    },
    /** The relay fails and comes back on the same port. */
    async restartRelay() {
      await stopProcess(stack.relay);
      stack.relay = (await startServer(relayEnv, { port: stack.relayPort })).child;
    },
  };
  return stack;
}
