/**
 * Admin API for one entry:  /api/caas-admin/content/{service}/{path...}
 *
 *   GET                      current content and metadata
 *   GET ?history=1           previous versions kept on this pod
 *   GET ?version=<hlc>       one previous version
 *   PUT    <json body>       create or replace
 *                            If-Match: <etag>   only if nobody changed it since it was read
 *                            If-None-Match: *   only if it does not exist yet (create a new route)
 *                            ?duplicates=error|first|last   how repeated keys are handled (default: refuse)
 *   DELETE                   remove
 *   POST   {"rollbackTo": "<hlc>"}   republish a previous version
 *
 * Every write is replicated to all pods and then purged from the CDN before
 * the response is returned; the response reports how that went.
 */
import { cleanContent, duplicatePolicyFrom, parseInput } from '@/lib/caas/content-input';
import { etagMatches, json, parseJson, problem, readBody, requireAdmin } from '@/lib/caas/http';
import { getRuntime, publish, type Runtime } from '@/lib/caas/runtime';
import { telemetry } from '@/lib/caas/telemetry';
import { normalizeKey, toMeta, type ContentKey, type Entry } from '@/lib/caas/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ service: string; path: string[] }> };

async function setup(req: Request, ctx: Ctx): Promise<{ rt: Runtime; actor: string; key: ContentKey } | Response> {
  const rt = getRuntime();
  const actor = requireAdmin(rt, req);
  if (actor instanceof Response) return actor;
  const { service, path } = await ctx.params;
  const key = normalizeKey(service, path);
  if (!key) return problem(400, 'invalid service or path');
  telemetry.annotate({ 'caas.service': key.service, 'caas.path': key.path });
  return { rt, actor, key };
}

async function respondPublished(rt: Runtime, entry: Entry, status = 200, extra: Record<string, unknown> = {}): Promise<Response> {
  const report = await publish(rt, [entry]);
  return json({ entry: toMeta(entry), ...extra, ...report }, status, entry.deleted ? {} : { etag: entry.etag });
}

/** Optimistic locking: stops two editors from silently overwriting each other. */
function preconditionFailed(req: Request, current: Entry | undefined): Response | undefined {
  const ifMatch = req.headers.get('if-match');
  if (!ifMatch) return undefined;
  if (current && !current.deleted && etagMatches(ifMatch, current.etag)) return undefined;
  return problem(412, 'content was changed by someone else; reload and retry', {
    currentEtag: current && !current.deleted ? current.etag : null,
  });
}

export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  const s = await setup(req, ctx);
  if (s instanceof Response) return s;
  const { rt, key } = s;
  const q = new URL(req.url).searchParams;

  if (q.get('history') === '1') return json({ ...key, versions: rt.store.history(key) });

  const version = q.get('version');
  const entry = version ? rt.store.historyVersion(key, version) : rt.store.get(key);
  if (!entry || (entry.deleted && !version)) return problem(404, 'content not found');
  return json(
    { entry: toMeta(entry), content: entry.deleted ? null : JSON.parse(entry.body) },
    200,
    entry.deleted ? {} : { etag: entry.etag },
  );
}

export async function PUT(req: Request, ctx: Ctx): Promise<Response> {
  const s = await setup(req, ctx);
  if (s instanceof Response) return s;
  const { rt, actor, key } = s;

  const duplicates = duplicatePolicyFrom(req);
  if (!duplicates) return problem(400, '"duplicates" must be error, first or last');
  const text = await readBody(req, rt.config.maxBodyBytes);
  if (text instanceof Response) return text;
  const parsed = parseInput(text, duplicates);
  if (!parsed.ok) return problem(parsed.status, parsed.error, parsed.details);
  const cleaned = cleanContent(parsed.value, rt.config.html, rt.config.maxBodyBytes);
  if (!cleaned.ok) return problem(cleaned.status, cleaned.error, cleaned.details);

  const current = rt.store.get(key);
  const exists = !!current && !current.deleted;
  if (req.headers.get('if-none-match')?.trim() === '*' && exists) {
    return problem(412, 'content already exists at this path', { currentEtag: current.etag });
  }
  const failed = preconditionFailed(req, current);
  if (failed) return failed;

  if (cleaned.sanitized.length > 0) telemetry.count('Writes/SanitizedValues', cleaned.sanitized.length);
  if (parsed.duplicates.length > 0) telemetry.count('Writes/DuplicateKeysResolved', parsed.duplicates.length);
  const extra = {
    sanitized: cleaned.sanitized,
    duplicatesResolved: parsed.duplicates.map(({ pointer, kept, values }) => ({ pointer, kept, count: values.length })),
  };
  return respondPublished(rt, rt.store.put(key, cleaned.body, actor), exists ? 200 : 201, extra);
}

export async function DELETE(req: Request, ctx: Ctx): Promise<Response> {
  const s = await setup(req, ctx);
  if (s instanceof Response) return s;
  const { rt, actor, key } = s;

  const current = rt.store.get(key);
  if (!current || current.deleted) return problem(404, 'content not found');
  const failed = preconditionFailed(req, current);
  if (failed) return failed;
  return respondPublished(rt, rt.store.remove(key, actor));
}

export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  const s = await setup(req, ctx);
  if (s instanceof Response) return s;
  const { rt, actor, key } = s;

  const text = await readBody(req, 10_000);
  if (text instanceof Response) return text;
  const hlc = parseJson<{ rollbackTo?: unknown }>(text)?.rollbackTo;
  if (typeof hlc !== 'string') return problem(400, 'expected {"rollbackTo": "<version>"}');

  const old = rt.store.historyVersion(key, hlc);
  if (!old) return problem(404, 'that version is not in this pod\'s history');
  // A rollback is a new write, so it replicates like any other change. Old
  // versions may predate the safety checks, so they go through them again.
  if (!old.deleted) {
    const cleaned = cleanContent(JSON.parse(old.body), rt.config.html, rt.config.maxBodyBytes);
    if (!cleaned.ok) return problem(cleaned.status, cleaned.error, cleaned.details);
    return respondPublished(rt, rt.store.put(key, cleaned.body, actor), 200, { sanitized: cleaned.sanitized });
  }
  return respondPublished(rt, rt.store.remove(key, actor));
}
