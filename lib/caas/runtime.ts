/**
 * Process-wide singleton that wires the pieces together. It lives on
 * globalThis because Next.js can load this module more than once (per route
 * bundle and for instrumentation) and there must be exactly one database
 * handle and one replication loop per pod.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { ResponseCache } from './cache';
import { CdnPurger, tags, type PurgeResult } from './cdn';
import { loadConfig, type CaasConfig } from './config';
import { openDatabase } from './db';
import { HybridClock } from './hlc';
import { Replicator, type PurgeScope, type PushResult } from './replication';
import { ContentStore, normalizeKey, type Entry } from './store';
import { telemetry, telemetryEnabled } from './telemetry';

export interface Runtime {
  config: CaasConfig;
  store: ContentStore;
  cache: ResponseCache;
  replicator: Replicator;
  purger: CdnPurger;
  readiness: { ready: boolean; reason: string; since?: number };
  started: boolean;
}

const globalKey = Symbol.for('caas.runtime');
type GlobalWithRuntime = typeof globalThis & { [globalKey]?: Runtime };

function log(cfg: CaasConfig, msg: string, level: 'info' | 'warn' | 'error' = 'info'): void {
  const line = JSON.stringify({ t: new Date().toISOString(), level, svc: 'caas', node: cfg.nodeId, env: cfg.env, zone: cfg.zone, msg });
  if (level === 'info') console.log(line);
  else console.error(line);
  telemetry.log(line, level);
}

/** Per-pod health snapshot for New Relic: one CaasHealth event per sync interval. */
function startHealthReporting(rt: Runtime): void {
  if (!telemetryEnabled()) return;
  const timer = setInterval(() => {
    const peers = rt.replicator.status();
    const inSync = peers.filter((p) => p.inSync).length;
    telemetry.event('CaasHealth', {
      node: rt.config.nodeId,
      env: rt.config.env,
      zone: rt.config.zone,
      ready: rt.readiness.ready,
      entries: rt.store.count(),
      memoryCacheEntries: rt.cache.size,
      peers: peers.length,
      peersInSync: inSync,
      peersWithErrors: peers.filter((p) => p.lastError).length,
    });
    telemetry.gauge('Peers/OutOfSync', peers.length - inSync);
    telemetry.gauge('Entries', rt.store.count());
  }, Math.max(rt.config.syncIntervalMs, 15_000));
  timer.unref?.();
}

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (name.endsWith('.json')) yield full;
  }
}

/** Loads content-seed/<service>/<path>.json. Seeds never override content edited at runtime. */
function loadSeed(cfg: CaasConfig, store: ContentStore): number {
  if (!existsSync(cfg.seedDir)) return 0;
  const rows: Entry[] = [];
  for (const file of walk(cfg.seedDir)) {
    const [service, ...rest] = relative(cfg.seedDir, file).split(sep);
    const key = normalizeKey(service, rest);
    if (!key) {
      log(cfg, `seed skipped (invalid name): ${file}`);
      continue;
    }
    try {
      rows.push(store.seedEntry(key, readFileSync(file, 'utf8'), cfg.seedVersion));
    } catch {
      log(cfg, `seed skipped (invalid JSON): ${file}`);
    }
  }
  return store.applyRemote(rows).length;
}

export function getRuntime(): Runtime {
  const g = globalThis as GlobalWithRuntime;
  if (!g[globalKey]) {
    const config = loadConfig();
    const store = new ContentStore(openDatabase(config.dataDir), new HybridClock(config.nodeId), config.historyLimit);
    const cache = new ResponseCache(config.memoryCacheEntries);
    store.onChange((e) => cache.invalidate(e));
    g[globalKey] = {
      config,
      store,
      cache,
      replicator: new Replicator(config, store, (m) => log(config, m)),
      purger: new CdnPurger(config.akamai),
      readiness: { ready: false, reason: 'starting' },
      started: false,
    };
  }
  return g[globalKey];
}

/** Called once from instrumentation.ts when the server process boots. */
export function startRuntime(): Runtime {
  const rt = getRuntime();
  if (rt.started) return rt;
  rt.started = true;
  const { config } = rt;

  const seeded = loadSeed(config, rt.store);
  log(config, `configuration: ${config.propertiesSource ? `environment + ${config.propertiesSource}` : 'environment only'}`);
  for (const w of config.warnings) log(config, `config warning: ${w}`, 'warn');
  log(config, `started; seed rows applied: ${seeded}; entries: ${rt.store.count()}`);
  if (!rt.replicator.enabled) log(config, 'CAAS_SYNC_SECRET is not set: replication between pods is DISABLED', 'warn');
  if (config.adminTokens.size === 0) log(config, 'CAAS_ADMIN_TOKENS is not set: the admin API is DISABLED', 'warn');
  startHealthReporting(rt);

  // Not awaited: the server must be listening so that peers can sync with this pod meanwhile.
  void rt.replicator
    .bootstrap()
    .catch((err) => `error: ${(err as Error).message}`)
    .then((reason) => {
      rt.readiness = { ready: true, reason, since: Date.now() };
      log(config, `ready (${reason}); entries: ${rt.store.count()}`);
      rt.replicator.start();
    });
  return rt;
}

export interface PublishReport {
  replication: PushResult[];
  cdn: PurgeResult;
}

/**
 * Runs after a local write: replicate first, then purge the CDN. The order
 * matters, otherwise the CDN could refill from a pod that still has the old row.
 */
export async function publish(rt: Runtime, entries: Entry[]): Promise<PublishReport> {
  const { group } = rt.config;
  const started = Date.now();
  const replication = await rt.replicator.broadcast(entries);
  // Akamai limits the size of a purge request; a big import purges per service instead of per entry.
  const purgeTags =
    entries.length > 50
      ? [...new Set(entries.map((e) => tags.service(group, e.service)))]
      : entries.map((e) => tags.entry(group, e));
  const cdn = await rt.purger.purgeTags(purgeTags);

  const failed = replication.filter((r) => !r.ok);
  telemetry.event('CaasPublish', {
    entries: entries.length,
    services: [...new Set(entries.map((e) => e.service))].join(',').slice(0, 255),
    deletes: entries.filter((e) => e.deleted).length,
    podsOk: replication.length - failed.length,
    podsFailed: failed.length,
    cdnStatus: cdn.status,
    durationMs: Date.now() - started,
    actor: entries[0]?.updatedBy,
  });
  if (failed.length > 0) {
    telemetry.error(new Error(`write not acknowledged by ${failed.length} of ${replication.length} pod(s)`), {
      'caas.stage': 'replication',
      'caas.failedPods': failed.map((f) => f.url).join(',').slice(0, 255),
    });
  }
  if (cdn.status === 'error') {
    telemetry.error(new Error(`CDN purge failed: ${cdn.detail ?? 'unknown'}`), { 'caas.stage': 'cdn-purge' });
  }

  if (cdn.status === 'ok' && replication.some((r) => !r.ok)) {
    // A pod that missed the push catches up through anti-entropy; purge again once it has.
    const again = setTimeout(() => void rt.purger.purgeTags(purgeTags), rt.config.syncIntervalMs * 2 + 1_000);
    again.unref?.();
  }
  return { replication, cdn };
}

/** Clears the in-memory cache on this pod for a scope and returns the matching CDN tags. */
export function purgeLocal(rt: Runtime, scope: PurgeScope): string[] {
  const { group } = rt.config;
  if (scope.service && scope.path) {
    const key = normalizeKey(scope.service, scope.path);
    if (!key) return [];
    rt.cache.invalidate(key);
    return [tags.entry(group, key)];
  }
  if (scope.service) {
    rt.cache.clear(scope.service);
    return [tags.service(group, scope.service)];
  }
  rt.cache.clear();
  return [tags.group(group)];
}
