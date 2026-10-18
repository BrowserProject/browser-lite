#!/usr/bin/env node
// browser-lite-server: Wisp relay, optional site (SITE_DIR) and browser profile (PROFILE_DIR) on
// one port. Environment variables: README.md of @browser-lite/server.
import { type App, createApp } from '../cli/app.js';
import { type CliConfig, readConfig } from '../cli/config.js';

const SHUTDOWN_TIMEOUT_MS = 5000;

let config: CliConfig;
let app: App;
try {
  config = readConfig(process.env);
  app = createApp(config, console);
} catch (error) {
  console.error(`browser-lite-server: ${(error as Error).message}`);
  process.exit(1);
}

if (!config.token && !config.secret)
  console.warn('No RELAY_TOKEN or RELAY_SECRET: relay and profile are open, run internally only.');
if (config.allowLocal)
  console.warn('RELAY_ALLOW_LOCAL=1: local addresses and all ports allowed, for tests only!');

// An error in a single connection must never end the whole server
process.on('uncaughtException', (error) => console.error('error (server keeps running):', error));
process.on('unhandledRejection', (error) => console.error('error (server keeps running):', error));

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  setTimeout(() => process.exit(0), SHUTDOWN_TIMEOUT_MS).unref();
  try {
    await app.close();
  } catch (error) {
    console.error('shutdown:', error);
  }
  process.exit(0);
}
// As PID 1 in a container, Node only ends on SIGTERM with a handler
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => void shutdown());

// Without the port (for example in use) never end silently with code 0
const failToStart = (error: Error) => {
  console.error(`browser-lite-server does not start: ${error.message}`);
  process.exit(1);
};
app.server.once('error', failToStart);
app.server.listen(config.port, config.host, () => {
  app.server.off('error', failToStart);
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  const extras = [
    config.siteDir ? `site from ${config.siteDir}` : '',
    config.profileDir ? `profile in ${config.profileDir}` : '',
  ].filter(Boolean);
  console.log(
    `browser-lite-server listening on ${config.host}:${port}${extras.length ? `, ${extras.join(', ')}` : ''}`,
  );
});
