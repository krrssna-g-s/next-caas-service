/**
 * Pod-to-pod replication API. Not for clients: block /api/internal/* at Apigee.
 * Every request must carry a valid HMAC signature made with CAAS_SYNC_SECRET.
 *
 *   GET  digest          -> this pod's id and state hash
 *   GET  digest?full=1   -> [service, path, version] for every row
 *   POST pull   {keys}   -> the full rows for those keys
 *   POST push   {entries, hop}  -> apply rows written on another pod
 *   POST purge  {service?, path?, hop} -> drop the in-memory response cache
 */
import { verifySync } from '@/lib/caas/auth';
import { json, parseJson, problem } from '@/lib/caas/http';
import type { Hop } from '@/lib/caas/replication';
import { getRuntime, purgeLocal } from '@/lib/caas/runtime';
import { isValidEntry, normalizeKey, type ContentKey } from '@/lib/caas/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ action: string }> };

function authorize(req: Request, action: string, body: string): Response | undefined {
  const { config } = getRuntime();
  if (!verifySync(config, req, action, body)) return problem(401, 'invalid sync signature');
  return undefined;
}

export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  const { action } = await ctx.params;
  const denied = authorize(req, action, '');
  if (denied) return denied;
  if (action !== 'digest') return problem(404, 'unknown sync action');

  const rt = getRuntime();
  const head = { node: rt.config.nodeId, group: rt.config.group, stateHash: rt.store.stateHash() };
  if (new URL(req.url).searchParams.get('full') === '1') return json({ ...head, entries: rt.store.digest() });
  return json(head);
}

export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  const { action } = await ctx.params;
  const text = await req.text();
  const denied = authorize(req, action, text);
  if (denied) return denied;

  const rt = getRuntime();
  const body = parseJson<Record<string, unknown>>(text);
  if (!body || typeof body !== 'object') return problem(400, 'body must be a JSON object');
  const hop: Hop = body.hop === 'relay' ? 'relay' : 'final';

  if (action === 'pull') {
    if (!Array.isArray(body.keys)) return problem(400, 'expected {"keys": [...]}');
    const keys = body.keys
      .map((k: { service?: unknown; path?: unknown }) =>
        typeof k?.service === 'string' && typeof k?.path === 'string' ? normalizeKey(k.service, k.path) : undefined,
      )
      .filter((k): k is ContentKey => k !== undefined);
    return json({ entries: rt.store.getMany(keys) });
  }

  if (action === 'push') {
    if (!Array.isArray(body.entries) || !body.entries.every(isValidEntry)) return problem(400, 'invalid entries');
    return json({ node: rt.config.nodeId, ...(await rt.replicator.handlePush(body.entries, hop)) });
  }

  if (action === 'purge') {
    const scope = {
      service: typeof body.service === 'string' ? body.service : undefined,
      path: typeof body.path === 'string' ? body.path : undefined,
    };
    purgeLocal(rt, scope);
    const relayed = hop === 'relay' ? await rt.replicator.broadcastPurge(scope, ['local']) : [];
    return json({ node: rt.config.nodeId, purged: true, relayed });
  }

  return problem(404, 'unknown sync action');
}
