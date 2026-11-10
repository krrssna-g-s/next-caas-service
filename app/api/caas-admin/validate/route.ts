/**
 * POST /api/caas-admin/validate   <json body>   (?duplicates=error|first|last)
 *
 * Runs the same checks as a save (duplicate keys, safety checks, size) and
 * reports what would happen, without storing or publishing anything:
 *   { ok: true,  sanitized: [{ pointer, reason, before, after }], duplicatesResolved: [...] }
 *   { ok: false, status, error, ...details }   when the save would be refused
 */
import { cleanContent, duplicatePolicyFrom, parseInput } from '@/lib/caas/content-input';
import { json, problem, readBody, requireAdmin } from '@/lib/caas/http';
import { getRuntime } from '@/lib/caas/runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  const rt = getRuntime();
  const actor = requireAdmin(rt, req);
  if (actor instanceof Response) return actor;
  const duplicates = duplicatePolicyFrom(req);
  if (!duplicates) return problem(400, '"duplicates" must be error, first or last');

  const text = await readBody(req, rt.config.maxBodyBytes);
  if (text instanceof Response) return text;
  const parsed = parseInput(text, duplicates);
  if (!parsed.ok) return json({ ok: false, status: parsed.status, error: parsed.error, ...parsed.details });
  const cleaned = cleanContent(parsed.value, rt.config.html, rt.config.maxBodyBytes);
  if (!cleaned.ok) return json({ ok: false, status: cleaned.status, error: cleaned.error, ...cleaned.details });
  return json({
    ok: true,
    sanitized: cleaned.sanitized,
    duplicatesResolved: parsed.duplicates.map(({ pointer, kept, values }) => ({ pointer, kept, count: values.length })),
  });
}
