/**
 * Server configuration.
 *
 * Every value comes from the environment with a sane default; `loadConfig(overrides)`
 * lets tests build a config object without touching the environment at all.
 *
 * Filesystem policy: `loadConfig` only touches the disk when it has to persist a
 * generated JWT secret. Passing `dataDir: ':memory:'` (what the test helper does)
 * skips that entirely, so a config is constructible in a read-only sandbox.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Sentinel used for both the SQLite path and the data dir in tests. */
export const MEMORY = ':memory:';

export interface Config {
  /** TCP port to listen on. */
  port: number;
  /** Bind address — 0.0.0.0 so phones on the LAN can reach the server. */
  host: string;
  /** Directory holding the SQLite file, the uploads folder and the JWT secret. */
  dataDir: string;
  /** Directory holding uploaded proof images (served at /uploads). */
  uploadDir: string;
  /** SQLite database file, or ':memory:'. */
  dbPath: string;
  /** Absolute base URL the phones use (PUBLIC_URL). */
  publicUrl: string;
  /**
   * True when PUBLIC_URL (or an override) actually named the address. The
   * default `http://localhost:<port>` is only right for the machine itself, so
   * pages that hand a link to somebody else build it from the request instead.
   */
  publicUrlExplicit: boolean;
  /**
   * Where a published Android build lives: `koydum.apk` plus `latest.json`
   * (`{ version, notes? }`), written by `npm run apk:yayinla`. Default
   * `<DATA_DIR>/app`.
   */
  appDir: string;
  /**
   * APP_DOWNLOAD_URL / APP_LATEST_VERSION: point at a build hosted elsewhere
   * (an expo.dev build page, Drive) instead of a file in `appDir`.
   */
  appDownloadUrl?: string;
  appLatestVersion?: string;
  /** Fastify log level. */
  logLevel: string;
  /** HS256 secret for API tokens. */
  jwtSecret: string;
  /** Optional Expo access token for push (expo.dev > Access tokens). */
  expoAccessToken?: string;
  /** ENABLE_DEV_ROUTES=1 mounts the test-only /dev/* endpoints. */
  enableDevRoutes: boolean;
  /**
   * Which hops may set X-Forwarded-For (Fastify's `trustProxy`).
   *
   * Default `'loopback'`: a tunnel or reverse proxy on the same machine
   * (cloudflared, localtunnel, nginx, Caddy) connects from 127.0.0.1, so its
   * forwarded client address is believed; a phone connecting directly is never
   * loopback, so it cannot pick its own IP and walk past the throttles. Never
   * `true` (trust everyone): then the LEFTMOST, client-written entry wins.
   *
   * TRUST_PROXY=0 → trust nobody; =1 → loopback; anything else is passed on as
   * an address / CIDR list, e.g. `10.0.0.0/8` for a proxy on another host.
   */
  trustProxy: false | string;
  /** Reported by GET /health. */
  version: string;
}

const DEFAULTS = {
  port: 4000,
  host: '0.0.0.0',
  dataDir: './data',
  logLevel: 'info',
  version: '1.0.0',
} as const;

function readInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readString(value: string | undefined, fallback: string): string {
  return value !== undefined && value.trim() !== '' ? value.trim() : fallback;
}

function isMemory(dataDir: string): boolean {
  return dataDir === MEMORY;
}

/** 32 random bytes as hex — the shape of a generated JWT secret. */
export function generateSecret(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Reads `<dataDir>/secret`, creating it (and the directory) with a fresh random
 * secret when it does not exist yet. Never called for an in-memory config.
 */
function loadOrCreateSecret(dataDir: string): string {
  const file = path.join(dataDir, 'secret');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length > 0) return existing;
  } catch {
    // missing or unreadable — fall through and create one
  }
  const secret = generateSecret();
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, `${secret}\n`, { mode: 0o600 });
  } catch {
    // read-only filesystem: keep the in-process secret (tokens die with the process)
  }
  return secret;
}

/**
 * Builds the config. `overrides` wins over the environment, which wins over the
 * defaults; derived values (uploadDir, dbPath, publicUrl) follow the overridden
 * dataDir/port unless they are overridden themselves.
 */
export function loadConfig(overrides: Partial<Config> = {}): Config {
  const env = process.env;

  const port = overrides.port ?? readInt(env.PORT, DEFAULTS.port);
  const host = overrides.host ?? readString(env.HOST, DEFAULTS.host);
  const dataDir = overrides.dataDir ?? readString(env.DATA_DIR, DEFAULTS.dataDir);
  const memory = isMemory(dataDir);

  const uploadDir =
    overrides.uploadDir ??
    (env.UPLOAD_DIR && env.UPLOAD_DIR.trim() !== ''
      ? env.UPLOAD_DIR.trim()
      : memory
        ? path.join(os.tmpdir(), 'koydum-test-uploads')
        : path.join(dataDir, 'uploads'));

  const dbPath = overrides.dbPath ?? (memory ? MEMORY : path.join(dataDir, 'koydum.db'));

  const publicUrlExplicit =
    overrides.publicUrlExplicit ??
    (overrides.publicUrl !== undefined || (env.PUBLIC_URL !== undefined && env.PUBLIC_URL.trim() !== ''));
  const publicUrl = (overrides.publicUrl ?? readString(env.PUBLIC_URL, `http://localhost:${port}`)).replace(/\/+$/, '');

  const appDir =
    overrides.appDir ??
    (env.APP_DIR && env.APP_DIR.trim() !== ''
      ? env.APP_DIR.trim()
      : memory
        ? path.join(os.tmpdir(), 'koydum-test-app')
        : path.join(dataDir, 'app'));
  const appDownloadUrl =
    overrides.appDownloadUrl ?? (env.APP_DOWNLOAD_URL && env.APP_DOWNLOAD_URL.trim() !== '' ? env.APP_DOWNLOAD_URL.trim() : undefined);
  const appLatestVersion =
    overrides.appLatestVersion ??
    (env.APP_LATEST_VERSION && env.APP_LATEST_VERSION.trim() !== '' ? env.APP_LATEST_VERSION.trim() : undefined);

  const logLevel = overrides.logLevel ?? readString(env.LOG_LEVEL, DEFAULTS.logLevel);

  const jwtSecret =
    overrides.jwtSecret ??
    (env.JWT_SECRET && env.JWT_SECRET.trim() !== ''
      ? env.JWT_SECRET.trim()
      : memory
        ? generateSecret()
        : loadOrCreateSecret(dataDir));

  const expoAccessToken =
    overrides.expoAccessToken ?? (env.EXPO_ACCESS_TOKEN && env.EXPO_ACCESS_TOKEN.trim() !== '' ? env.EXPO_ACCESS_TOKEN.trim() : undefined);

  const enableDevRoutes = overrides.enableDevRoutes ?? env.ENABLE_DEV_ROUTES === '1';
  const rawTrust = (env.TRUST_PROXY ?? '').trim().toLowerCase();
  const trustProxy: false | string =
    overrides.trustProxy ??
    (rawTrust === '0' || rawTrust === 'false'
      ? false
      : rawTrust === '' || rawTrust === '1' || rawTrust === 'true'
        ? 'loopback'
        : (env.TRUST_PROXY ?? '').trim());

  const version = overrides.version ?? readString(env.npm_package_version, DEFAULTS.version);

  return {
    port,
    host,
    dataDir,
    uploadDir,
    dbPath,
    publicUrl,
    publicUrlExplicit,
    appDir,
    appDownloadUrl,
    appLatestVersion,
    logLevel,
    jwtSecret,
    expoAccessToken,
    enableDevRoutes,
    trustProxy,
    version,
  };
}
