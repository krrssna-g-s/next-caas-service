/**
 * Kubernetes probes.
 *   GET /api/health/live   -> 200 while the process is up
 *   GET /api/health/ready  -> 200 only after the pod has synced its database with its peers
 */
import { json } from '@/lib/caas/http';
import { getRuntime } from '@/lib/caas/runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ probe: string }> }): Promise<Response> {
  const { probe } = await ctx.params;
  if (probe === 'live') return json({ status: 'ok' });
  if (probe !== 'ready') return json({ error: 'unknown probe' }, 404);

  const rt = getRuntime();
  const { ready, reason } = rt.readiness;
  return json(
    { status: ready ? 'ready' : 'starting', reason, node: rt.config.nodeId, env: rt.config.env, zone: rt.config.zone },
    ready ? 200 : 503,
  );
}
