/**
 * Configuration from global.properties, read with the properties-reader
 * module and turned into the same flat NAME=value map that environment
 * variables provide, so loadConfig() does not care where a value came from.
 *
 * Where the file comes from (it is not part of this repository or the image):
 *   PROPS_PATH=https://props.internal/...    fetched over HTTP(S) once at startup
 *                                            (the properties service in EKS)
 *   PROPS_PATH=/mnt/props/global.properties  read from disk
 *   PROPS_PATH unset                         ./global.properties if it exists (local)
 *
 * File format (properties-reader): key=value lines, # comments, and
 * [section] headers that prefix the keys below them with "section.".
 *
 * Key names: either the environment-variable name (CAAS_CDN_MAX_AGE) or a
 * dotted name (caas.cdn.max-age, akamai.client.token). Dotted names are
 * upper-cased and '.' / '-' become '_'.
 *
 * Environment- and zone-specific values, as a key prefix or a section:
 *   caas.cdn.max.age=86400              every environment
 *   sit.caas.cdn.max.age=300            only when CAAS_ENV=sit
 *   [prod.west]                         everything below: CAAS_ENV=prod and CAAS_ZONE=west
 *   caas.remote.peers=https://...
 * Keys scoped to another environment or zone are ignored.
 *
 * Precedence (highest first):
 *   real environment variable > env.zone.KEY > env.KEY > KEY
 * so a value set in the pod spec or a Secret always wins over the file.
 *
 * Values may reference other values as ${NAME} (resolved from the
 * environment, then from the file), e.g. caas.sync.secret=${SYNC_SECRET}.
 * An unresolved reference stops startup rather than running with a bad value.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { propertiesReader } from 'properties-reader';

export type Env = Record<string, string | undefined>;
/** Raw key -> value as properties-reader produced it (sections already prefixed). */
export type RawProperties = Map<string, string>;

/** Raw strings only: properties-reader's get() would turn "0012" into 12 and "null" into null. */
function toMap(all: Record<string, string>): RawProperties {
  // A UTF-8 byte-order mark would otherwise end up in the first key.
  const stripBom = (k: string) => (k.charCodeAt(0) === 0xfeff ? k.slice(1) : k);
  return new Map(Object.entries(all).map(([k, v]) => [stripBom(k), v]));
}

export function readPropertiesFile(file: string): RawProperties {
  return toMap(propertiesReader({ sourceFile: file, encoding: 'utf8' }).getAllProperties());
}

export function readPropertiesText(text: string): RawProperties {
  return toMap(propertiesReader().read(text).getAllProperties());
}

/** caas.cdn.max-age -> CAAS_CDN_MAX_AGE; CAAS_CDN_MAX_AGE stays as is. */
export function toEnvName(key: string): string {
  return key.trim().replace(/[.\-\s]+/g, '_').toUpperCase();
}

export interface ResolvedProperties {
  /** Flat NAME -> value for the active environment and zone. */
  values: Record<string, string>;
  env: string;
  zone: string;
  /** NAME -> which property key supplied it (for diagnostics; never the value). */
  sources: Record<string, string>;
}

/**
 * Picks the values that apply to one environment and zone. `known` lists the
 * environment and zone names, used to tell "prod.KEY" (scoped) from a dotted
 * key name that happens to start with another word.
 */
export function resolveProperties(raw: RawProperties, base: Env, known: { envs: string[]; zones: string[] }): ResolvedProperties {
  const envs = new Set(known.envs.map((s) => s.toLowerCase()));
  const zones = new Set(known.zones.map((s) => s.toLowerCase()));

  type Scoped = { name: string; env?: string; zone?: string; key: string; value: string };
  const items: Scoped[] = [];
  for (const [key, value] of raw) {
    const parts = key.split('.');
    const first = parts[0]?.toLowerCase();
    const second = parts[1]?.toLowerCase();
    if (parts.length > 2 && envs.has(first) && zones.has(second)) {
      items.push({ name: toEnvName(parts.slice(2).join('.')), env: first, zone: second, key, value });
    } else if (parts.length > 1 && envs.has(first)) {
      items.push({ name: toEnvName(parts.slice(1).join('.')), env: first, key, value });
    } else {
      items.push({ name: toEnvName(key), key, value });
    }
  }

  // The environment and zone may come from the file (unscoped) when not set in the real environment.
  const unscoped = (name: string) => items.find((it) => !it.env && it.name === name)?.value;
  const env = (base.CAAS_ENV ?? unscoped('CAAS_ENV') ?? 'local').toLowerCase();
  const zone = (base.CAAS_ZONE ?? unscoped('CAAS_ZONE') ?? 'local').toLowerCase();

  const rank = (it: Scoped) => (it.env && it.zone ? 3 : it.env ? 2 : 1);
  const chosen = new Map<string, Scoped>();
  for (const it of items) {
    if (it.env && it.env !== env) continue;
    if (it.zone && it.zone !== zone) continue;
    const cur = chosen.get(it.name);
    if (!cur || rank(it) >= rank(cur)) chosen.set(it.name, it);
  }

  const picked: Record<string, string> = {};
  const sources: Record<string, string> = {};
  for (const [name, it] of chosen) {
    picked[name] = it.value;
    sources[name] = it.key;
  }

  // ${NAME} references: real environment first, then the file's own values.
  const values: Record<string, string> = {};
  const expand = (name: string, stack: string[]): string => {
    if (name in values) return values[name];
    if (stack.includes(name)) throw new Error(`properties: circular \${} reference ${[...stack, name].join(' -> ')}`);
    const out = picked[name].replace(/\$\{([A-Za-z0-9_.-]+)\}/g, (_m, ref: string) => {
      const refName = toEnvName(ref);
      const fromEnv = base[refName] ?? base[ref];
      if (fromEnv !== undefined) return fromEnv;
      if (refName in picked) return expand(refName, [...stack, name]);
      throw new Error(`properties: ${sources[name]} references \${${ref}}, which is not set`);
    });
    values[name] = out;
    return out;
  };
  for (const name of Object.keys(picked)) expand(name, []);

  return { values, env, zone, sources };
}

export const KNOWN_ENVS = ['local', 'dev', 'sit', 'uat', 'canary', 'stage', 'staging', 'perf', 'preprod', 'prod'];
export const KNOWN_ZONES = ['local', 'east', 'west', 'central', 'north', 'south'];

// ---------------------------------------------------------------- loading

interface Loaded {
  source: string;
  raw: RawProperties;
}

const cacheKey = Symbol.for('caas.properties');
type G = typeof globalThis & { [cacheKey]?: Loaded | null };

const isUrl = (p: string) => /^https?:\/\//i.test(p);

/** URL as it may appear in logs: no user:password, no query string. */
export function redactUrl(u: string): string {
  try {
    const url = new URL(u);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return '(invalid URL)';
  }
}

const MAX_PROPS_BYTES = 1024 * 1024;

/**
 * Fetches the properties from the properties service, retrying with backoff
 * until PROPS_FETCH_TIMEOUT_MS (default 30 s) has passed. Optional PROPS_AUTH
 * is sent as the Authorization header (e.g. "Bearer <token>"); user:password
 * in the URL is sent as Basic auth.
 */
export async function fetchProperties(url: string, base: Env = process.env): Promise<string> {
  const deadline = Date.now() + Number(base.PROPS_FETCH_TIMEOUT_MS ?? 30_000);
  const headers: Record<string, string> = { accept: 'text/plain, */*' };
  // fetch() refuses user:password@ in a URL; send it as Basic auth instead.
  const target = new URL(url);
  if (target.username || target.password) {
    const user = decodeURIComponent(target.username);
    const pass = decodeURIComponent(target.password);
    headers.authorization = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
    target.username = '';
    target.password = '';
  }
  if (base.PROPS_AUTH) headers.authorization = base.PROPS_AUTH;
  let delay = 250;
  let lastError = '';
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(target, { headers, redirect: 'error', signal: AbortSignal.timeout(5_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (Buffer.byteLength(text) > MAX_PROPS_BYTES) throw new Error(`larger than ${MAX_PROPS_BYTES} bytes`);
      return text;
    } catch (err) {
      lastError = (err as Error).message;
    }
    if (Date.now() + delay > deadline) {
      throw new Error(`could not load properties from ${redactUrl(url)} after ${attempt} attempt(s): ${lastError}`);
    }
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, 4_000);
  }
}

function readLocal(path: string | undefined, cwd: string): Loaded | null {
  if (path) {
    const file = resolve(cwd, path);
    if (!existsSync(file)) throw new Error(`PROPS_PATH=${path} does not exist`);
    return { source: file, raw: readPropertiesFile(file) };
  }
  const local = resolve(cwd, 'global.properties');
  return existsSync(local) ? { source: local, raw: readPropertiesFile(local) } : null;
}

/**
 * Loads the properties once for the whole process. Must run before the first
 * loadConfig() when PROPS_PATH is a URL; instrumentation.ts does this at startup.
 */
export async function preloadProperties(base: Env = process.env, cwd = process.cwd()): Promise<string | undefined> {
  const g = globalThis as G;
  if (g[cacheKey] !== undefined) return g[cacheKey]?.source;
  const path = base.PROPS_PATH?.trim();
  g[cacheKey] =
    path && isUrl(path) ? { source: redactUrl(path), raw: readPropertiesText(await fetchProperties(path, base)) } : readLocal(path, cwd);
  return g[cacheKey]?.source;
}

/** For tests: forget what was preloaded. */
export function resetPreloadedProperties(): void {
  delete (globalThis as G)[cacheKey];
}

export interface LoadedEnvironment {
  env: Env;
  /** Where the properties came from (URL without credentials or query, or a file path). */
  source?: string;
  warnings: string[];
}

/**
 * Returns process.env merged over the values from the properties. No
 * properties is fine: configuration then comes from the environment alone.
 * Extra environment / zone names can be declared with CAAS_KNOWN_ENVS and
 * CAAS_KNOWN_ZONES (comma-separated) in the environment or the file.
 */
export function loadEnvironment(base: Env = process.env, cwd = process.cwd()): LoadedEnvironment {
  const g = globalThis as G;
  const path = base.PROPS_PATH?.trim();
  let props: Loaded | null;
  if (g[cacheKey] !== undefined) props = g[cacheKey];
  else if (path && isUrl(path)) {
    throw new Error('PROPS_PATH is a URL; preloadProperties() must run at startup before configuration is read');
  } else props = readLocal(path, cwd);
  if (!props) return { env: base, warnings: [] };

  const raw = props.raw;
  const extra = (name: string) =>
    (base[name] ?? raw.get(name) ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  const resolved = resolveProperties(raw, base, {
    envs: [...KNOWN_ENVS, ...extra('CAAS_KNOWN_ENVS')],
    zones: [...KNOWN_ZONES, ...extra('CAAS_KNOWN_ZONES')],
  });

  // Real environment variables win; only fill in what they leave unset.
  const env: Env = { ...resolved.values };
  for (const [k, v] of Object.entries(base)) if (v !== undefined) env[k] = v;
  env.CAAS_ENV ??= resolved.env;
  env.CAAS_ZONE ??= resolved.zone;
  return { env, source: props.source, warnings: [] };
}
