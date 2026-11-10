/**
 * GET /api/caas-admin/content?service=&prefix=&deleted=1
 * Lists entries (metadata only) and the services that exist.
 */
import { json, requireAdmin } from '@/lib/caas/http';
import { getRuntime } from '@/lib/caas/runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const rt = getRuntime();
  const actor = requireAdmin(rt, req);
  if (actor instanceof Response) return actor;

  const q = new URL(req.url).searchParams;
  const entries = rt.store.list({
    service: q.get('service') ?? undefined,
    prefix: q.get('prefix') ?? undefined,
    includeDeleted: q.get('deleted') === '1',
  });
  const services = [...new Set(rt.store.list().map((e) => e.service))];
  return json({ services, count: entries.length, entries });
}
