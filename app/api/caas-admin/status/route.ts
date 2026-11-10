/**
 * GET /api/caas-admin/status
 * Shows this pod's view of the cluster: its peers, whether they hold the same
 * data (same state hash), and whether CDN purging is configured.
 */
import { json, requireAdmin } from '@/lib/caas/http';
import { getRuntime } from '@/lib/caas/runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const rt = getRuntime();
  const actor = requireAdmin(rt, req);
  if (actor instanceof Response) return actor;

  const { config: cfg } = rt;
  return json({
    node: cfg.nodeId,
    env: cfg.env,
    zone: cfg.zone,
    group: cfg.group,
    readiness: rt.readiness,
    entries: rt.store.count(),
    stateHash: rt.store.stateHash(),
    memoryCacheEntries: rt.cache.size,
    replicationEnabled: rt.replicator.enabled,
    cdnPurgeConfigured: rt.purger.configured,
    // Where configuration came from (path only; values are never returned).
    configSource: cfg.propertiesSource ? 'environment + properties' : 'environment',
    propertiesSource: cfg.propertiesSource ?? null,
    peers: rt.replicator.status(),
  });
}
