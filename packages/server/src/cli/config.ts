import path from 'node:path';

/** Settings of the `browser-lite-server` command, read from the environment. */
export interface CliConfig {
  port: number;
  host: string;
  siteDir: string | null;
  profileDir: string | null;
  profileMaxBytes: number;
  /** Host names of relay and profile besides IP addresses and localhost. */
  hosts: string[];
  token: string | undefined;
  secret: string | undefined;
  allowedOrigins: string[] | undefined;
  /** Number of reverse proxies in front that append to `X-Forwarded-For`. */
  trustProxy: number;
  allowLocal: boolean;
}

const list = (value: string | undefined) =>
  (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

function integer(name: string, value: string | undefined, fallback: number, min: number): number {
  if (value === undefined || value === '') return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min)
    throw new Error(`${name} must be an integer >= ${min}`);
  return number;
}

/** Reads the configuration; throws an Error with a message for the user on invalid values. */
export function readConfig(env: NodeJS.ProcessEnv): CliConfig {
  const port = integer('PORT', env.PORT, 5001, 0);
  if (port > 65535) throw new Error('PORT must be at most 65535');
  const origins = list(env.RELAY_ALLOWED_ORIGINS);
  for (const origin of origins) {
    if (origin !== '*' && !URL.canParse(origin))
      throw new Error(`RELAY_ALLOWED_ORIGINS: invalid origin ${origin}`);
  }
  return {
    port,
    host: env.HOST || '0.0.0.0',
    siteDir: env.SITE_DIR ? path.resolve(env.SITE_DIR) : null,
    profileDir: env.PROFILE_DIR ? path.resolve(env.PROFILE_DIR) : null,
    profileMaxBytes: integer('PROFILE_MAX_MB', env.PROFILE_MAX_MB, 64, 1) * 1024 * 1024,
    hosts: list(env.ALLOWED_HOSTS),
    token: env.RELAY_TOKEN || undefined,
    secret: env.RELAY_SECRET || undefined,
    allowedOrigins: origins.length ? origins : undefined,
    trustProxy: integer('RELAY_TRUST_PROXY', env.RELAY_TRUST_PROXY, 0, 0),
    allowLocal: env.RELAY_ALLOW_LOCAL === '1',
  };
}
