/**
 * Content keys: which service names and paths are allowed. Shared by the
 * server and the admin page, so it must not import any Node-only module.
 */

export interface ContentKey {
  service: string;
  path: string;
}

export const SERVICE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const SEGMENT_RE = /^[A-Za-z0-9._~-]+$/;
export const MAX_PATH = 512;

/**
 * Validates and normalises a content key. A trailing ".json" is dropped, so
 * /api/caas/offers/home/hero and /api/caas/offers/home/hero.json are the same entry.
 */
export function normalizeKey(service: string, path: string | string[]): ContentKey | undefined {
  const svc = String(service).toLowerCase();
  if (!SERVICE_RE.test(svc)) return undefined;
  const segments = (Array.isArray(path) ? path : String(path).split('/')).filter((s) => s !== '');
  if (segments.length === 0) return undefined;
  const last = segments.length - 1;
  if (segments[last].toLowerCase().endsWith('.json')) segments[last] = segments[last].slice(0, -5);
  for (const seg of segments) {
    if (!SEGMENT_RE.test(seg) || seg === '.' || seg === '..') return undefined;
  }
  const joined = segments.join('/');
  if (joined.length > MAX_PATH) return undefined;
  return { service: svc, path: joined };
}
