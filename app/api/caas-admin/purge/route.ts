/**
 * POST /api/caas-admin/purge
 *   {}                                  everything in this replication group
 *   {"service": "offers"}               one service
 *   {"service": "offers", "path": "home/hero"}   one entry
 *
 * Clears the in-memory cache on every pod (all zones) and purges Akamai.
 * Content updates purge automatically; this endpoint is for manual clears.
 */
import { json, parseJson, problem, readBody, requireAdmin } from '@/lib/caas/http';
import { getRuntime, purgeLocal } from '@/lib/caas/runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  const rt = getRuntime();
  const actor = requireAdmin(rt, req);
  if (actor instanceof Response) return actor;

  const text = await readBody(req, 10_000);
  if (text instanceof Response) return text;
  const body = text ? parseJson<{ service?: unknown; path?: unknown }>(text) : {};
  if (!body || typeof body !== 'object') return problem(400, 'body must be a JSON object');
  const scope = {
    service: typeof body.service === 'string' ? body.service : undefined,
    path: typeof body.path === 'string' ? body.path : undefined,
  };
  if (scope.path && !scope.service) return problem(400, '"path" requires "service"');

  const purgeTags = purgeLocal(rt, scope);
  if (purgeTags.length === 0) return problem(400, 'invalid service or path');
  const pods = await rt.replicator.broadcastPurge(scope);
  const cdn = await rt.purger.purgeTags(purgeTags);
  return json({ scope, pods, cdn });
}
