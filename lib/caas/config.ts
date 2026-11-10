/**
 * All behaviour that differs between SIT / CANARY / STAGE / PROD and between
 * east / west comes from environment variables. The code and the routes are
 * identical everywhere.
 */
import { hostname } from 'node:os';
import { loadEnvironment } from './properties';

export interface AkamaiConfig {
  /** e.g. https://akab-xxxx.luna.akamaiapis.net */
  baseUrl: string;
  clientToken: string;
  clientSecret: string;
  accessToken: string;
  /** "production" or "staging" Akamai network */
  network: string;
  /** "invalidate" (recommended) or "delete" */
  mode: string;
}

export interface CaasConfig {
  env: string;
  zone: string;
  /** Pods with the same group replicate to each other. Canary normally uses "prod". */
  group: string;
  nodeId: string;
  podIp?: string;

  dataDir: string;
  seedDir: string;
  seedVersion: number;

  /** token -> actor name */
  adminTokens: Map<string, string>;
  syncSecret: string;

  peerDns: string[];
  peerPort: number;
  staticPeers: string[];
  remotePeers: string[];

  syncIntervalMs: number;
  pushTimeoutMs: number;
  bootstrapTimeoutMs: number;

  browserMaxAge: number;
  cdnMaxAge: number;
  notFoundCdnMaxAge: number;
  staleWhileRevalidate: number;
  corsAllowOrigin?: string;

  maxBodyBytes: number;
  historyLimit: number;
  /** "sanitize" cleans unsafe HTML out of string values; "reject" refuses the write. */
  htmlPolicy: 'sanitize' | 'reject';
  memoryCacheEntries: number;

  akamai?: AkamaiConfig;

  /** Where global.properties was read from (URL without credentials, or file path), if anywhere. */
  propertiesSource?: string;
  /** Problems found while reading configuration that did not stop startup. */
  warnings: string[];
}

type Env = Record<string, string | undefined>;

function int(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number, got "${raw}"`);
  return Math.floor(n);
}

function list(env: Env, name: string): string[] {
  return (env[name] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseAdminTokens(env: Env): Map<string, string> {
  // CAAS_ADMIN_TOKENS="alice:tokenA,release-bot:tokenB"  (a bare token gets the name "admin")
  const tokens = new Map<string, string>();
  for (const item of list(env, 'CAAS_ADMIN_TOKENS')) {
    const i = item.indexOf(':');
    const name = i > 0 ? item.slice(0, i) : 'admin';
    const token = i > 0 ? item.slice(i + 1) : item;
    if (token.length < 16) throw new Error('CAAS_ADMIN_TOKENS: each token must be at least 16 characters');
    tokens.set(token, name);
  }
  return tokens;
}

function parseAkamai(env: Env): AkamaiConfig | undefined {
  const host = env.AKAMAI_HOST;
  const baseUrl = env.AKAMAI_BASE_URL ?? (host ? `https://${host}` : undefined);
  const { AKAMAI_CLIENT_TOKEN, AKAMAI_CLIENT_SECRET, AKAMAI_ACCESS_TOKEN } = env;
  if (!baseUrl || !AKAMAI_CLIENT_TOKEN || !AKAMAI_CLIENT_SECRET || !AKAMAI_ACCESS_TOKEN) return undefined;
  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    clientToken: AKAMAI_CLIENT_TOKEN,
    clientSecret: AKAMAI_CLIENT_SECRET,
    accessToken: AKAMAI_ACCESS_TOKEN,
    network: env.AKAMAI_NETWORK ?? 'production',
    mode: env.AKAMAI_PURGE_MODE ?? 'invalidate',
  };
}

function htmlPolicy(env: Env): 'sanitize' | 'reject' {
  const v = (env.CAAS_HTML_POLICY ?? 'sanitize').toLowerCase();
  if (v !== 'sanitize' && v !== 'reject') throw new Error(`CAAS_HTML_POLICY must be "sanitize" or "reject", got "${v}"`);
  return v;
}

/**
 * Builds the configuration from environment variables merged over
 * global.properties (see lib/caas/properties.ts). Pass `env` to skip the file.
 */
export function loadConfig(env?: Env): CaasConfig {
  if (env === undefined) {
    const loaded = loadEnvironment(process.env);
    const cfg = buildConfig(loaded.env);
    return { ...cfg, propertiesSource: loaded.source, warnings: loaded.warnings };
  }
  return buildConfig(env);
}

function buildConfig(env: Env): CaasConfig {
  const caasEnv = (env.CAAS_ENV ?? 'local').toLowerCase();
  const syncSecret = env.CAAS_SYNC_SECRET ?? '';
  if (syncSecret && syncSecret.length < 16) throw new Error('CAAS_SYNC_SECRET must be at least 16 characters');

  return {
    env: caasEnv,
    zone: (env.CAAS_ZONE ?? 'local').toLowerCase(),
    group: (env.CAAS_REPLICATION_GROUP ?? caasEnv).toLowerCase(),
    // Must be unique per pod. The HOSTNAME variable is deliberately not used: the Next.js
    // standalone server repurposes it as the bind address (0.0.0.0).
    nodeId: env.POD_NAME ?? `${hostname()}-${env.PORT ?? '3000'}`,
    podIp: env.POD_IP,

    dataDir: env.CAAS_DATA_DIR ?? './.caas-data',
    seedDir: env.CAAS_SEED_DIR ?? './content-seed',
    seedVersion: Math.max(1, int(env, 'CAAS_SEED_VERSION', 1)),

    adminTokens: parseAdminTokens(env),
    syncSecret,

    peerDns: list(env, 'CAAS_PEER_DNS'),
    peerPort: int(env, 'CAAS_PEER_PORT', int(env, 'PORT', 3000)),
    staticPeers: list(env, 'CAAS_PEERS').map((u) => u.replace(/\/+$/, '')),
    remotePeers: list(env, 'CAAS_REMOTE_PEERS').map((u) => u.replace(/\/+$/, '')),

    syncIntervalMs: Math.max(500, int(env, 'CAAS_SYNC_INTERVAL_MS', 15_000)),
    pushTimeoutMs: Math.max(200, int(env, 'CAAS_PUSH_TIMEOUT_MS', 3_000)),
    bootstrapTimeoutMs: int(env, 'CAAS_BOOTSTRAP_TIMEOUT_MS', 30_000),

    browserMaxAge: int(env, 'CAAS_BROWSER_MAX_AGE', 60),
    cdnMaxAge: int(env, 'CAAS_CDN_MAX_AGE', 86_400),
    notFoundCdnMaxAge: int(env, 'CAAS_NOT_FOUND_CDN_MAX_AGE', 30),
    staleWhileRevalidate: int(env, 'CAAS_STALE_WHILE_REVALIDATE', 30),
    corsAllowOrigin: env.CAAS_CORS_ALLOW_ORIGIN || undefined,

    maxBodyBytes: int(env, 'CAAS_MAX_BODY_BYTES', 1_048_576),
    historyLimit: Math.max(1, int(env, 'CAAS_HISTORY_LIMIT', 20)),
    htmlPolicy: htmlPolicy(env),
    memoryCacheEntries: Math.max(1, int(env, 'CAAS_MEMORY_CACHE_ENTRIES', 5_000)),

    akamai: parseAkamai(env),
    warnings: [],
  };
}
