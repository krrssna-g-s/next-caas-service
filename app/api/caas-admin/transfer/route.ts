/**
 * Bulk export and import, for backups and for the one-time migration from AEM.
 *
 *   GET  /api/caas-admin/transfer            -> {"entries":[{"service","path","content"}, ...]}
 *   POST /api/caas-admin/transfer  (same shape) -> imports every entry, then replicates and purges once
 *        ?duplicates=error|first|last   repeated keys anywhere in the file (default: refuse)
 *        ?mode=upsert|create            "create" refuses entries that already exist
 *        ?dryRun=1                      check everything and report, write nothing
 *
 * The same entry listed twice in one file is refused: which one is meant is
 * the caller's decision, not the importer's.
 */
import { cleanContent, duplicatePolicyFrom, parseInput } from '@/lib/caas/content-input';
import { json, problem, readBody, requireAdmin } from '@/lib/caas/http';
import type { Json } from '@/lib/caas/json-tools';
import { telemetry } from '@/lib/caas/telemetry';
import { getRuntime, publish } from '@/lib/caas/runtime';
import { normalizeKey, type ContentKey, type Entry } from '@/lib/caas/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_IMPORT_BYTES = 50 * 1024 * 1024;

export async function GET(req: Request): Promise<Response> {
  const rt = getRuntime();
  const actor = requireAdmin(rt, req);
  if (actor instanceof Response) return actor;

  const entries = rt.store.exportAll().map((e) => ({ service: e.service, path: e.path, content: JSON.parse(e.body) }));
  return json({ exportedAt: new Date().toISOString(), group: rt.config.group, count: entries.length, entries });
}

export async function POST(req: Request): Promise<Response> {
  const rt = getRuntime();
  const actor = requireAdmin(rt, req);
  if (actor instanceof Response) return actor;

  const duplicates = duplicatePolicyFrom(req);
  if (!duplicates) return problem(400, '"duplicates" must be error, first or last');
  const mode = new URL(req.url).searchParams.get('mode') ?? 'upsert';
  if (mode !== 'upsert' && mode !== 'create') return problem(400, '"mode" must be upsert or create');

  const text = await readBody(req, MAX_IMPORT_BYTES);
  if (text instanceof Response) return text;
  const parsed = parseInput(text, duplicates);
  if (!parsed.ok) return problem(parsed.status, parsed.error, parsed.details);
  const items = (parsed.value as { entries?: Json } | null)?.entries;
  if (!Array.isArray(items)) return problem(400, 'expected {"entries":[{"service","path","content"}]}');

  // Validate everything first so a bad item cannot leave a half-applied import.
  const valid: Array<{ key: ContentKey; body: string }> = [];
  const rejected: Array<{ index: number; reason: string; details?: unknown }> = [];
  const sanitized: Array<{ index: number; pointer: string; reason: string }> = [];
  const firstIndex = new Map<string, number>();
  items.forEach((raw, index) => {
    const item = (raw ?? {}) as { service?: Json; path?: Json; content?: Json };
    const key = typeof item.service === 'string' && typeof item.path === 'string' ? normalizeKey(item.service, item.path) : undefined;
    if (!key) return rejected.push({ index, reason: 'invalid service or path' });
    if (item.content === undefined) return rejected.push({ index, reason: 'missing content' });
    const id = `${key.service}/${key.path}`;
    const dup = firstIndex.get(id);
    if (dup !== undefined) return rejected.push({ index, reason: `same service and path as entry ${dup}` });
    firstIndex.set(id, index);
    if (mode === 'create') {
      const existing = rt.store.get(key);
      if (existing && !existing.deleted) return rejected.push({ index, reason: 'already exists' });
    }
    const cleaned = cleanContent(item.content, rt.config.html, rt.config.maxBodyBytes);
    if (!cleaned.ok) return rejected.push({ index, reason: cleaned.error, details: cleaned.details });
    for (const s of cleaned.sanitized) sanitized.push({ index, ...s });
    valid.push({ key, body: cleaned.body });
  });
  if (new URL(req.url).searchParams.get('dryRun') === '1') {
    return json({ dryRun: true, ok: rejected.length === 0, wouldImport: valid.length, rejected, sanitized });
  }
  if (rejected.length > 0) return problem(400, 'import rejected; nothing was written', { rejected });

  if (sanitized.length > 0) telemetry.count('Writes/SanitizedValues', sanitized.length);
  telemetry.annotate({ 'caas.importCount': valid.length });
  const written: Entry[] = valid.map(({ key, body }) => rt.store.put(key, body, actor));
  const report = await publish(rt, written);
  return json({ imported: written.length, sanitized, ...report });
}
