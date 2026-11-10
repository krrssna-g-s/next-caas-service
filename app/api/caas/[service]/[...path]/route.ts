/**
 * Public content API:  GET /api/caas/{service}/{path...}[.json]
 *
 * The same route serves every CaaS service in every environment and zone.
 * Responses are cacheable by the browser and by Akamai, and are tagged so
 * they can be purged the moment the content changes.
 */
import { tags } from '@/lib/caas/cdn';
import { API_SECURITY_HEADERS, etagMatches } from '@/lib/caas/http';
import { escapeJsonText } from '@/lib/caas/json-tools';
import { getRuntime } from '@/lib/caas/runtime';
import { normalizeKey } from '@/lib/caas/store';
import { telemetry } from '@/lib/caas/telemetry';

export const runtime = 'nodejs';
// Next.js must never cache this handler itself; caching is done by the layers below.
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ service: string; path: string[] }> };

export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  const rt = getRuntime();
  const cfg = rt.config;
  const { service, path } = await ctx.params;
  const key = normalizeKey(service, path);

  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'x-caas-env': cfg.env,
    'x-caas-zone': cfg.zone,
    'x-caas-node': cfg.nodeId,
    ...API_SECURITY_HEADERS,
  });
  if (cfg.corsAllowOrigin) headers.set('access-control-allow-origin', cfg.corsAllowOrigin);

  if (!key) {
    headers.set('cache-control', 'no-store');
    return new Response(JSON.stringify({ error: 'invalid content path' }), { status: 400, headers });
  }

  let hit = rt.cache.get(key);
  headers.set('x-caas-cache', hit ? 'HIT' : 'MISS');
  if (!hit) {
    const entry = rt.store.get(key);
    hit =
      entry && !entry.deleted
        ? // Escaping <, >, & keeps the JSON byte-for-byte equivalent but inert if a consumer inlines it in HTML.
          { found: true, body: escapeJsonText(entry.body), etag: entry.etag, hlc: entry.hlc, updatedAt: entry.updatedAt }
        : { found: false, body: JSON.stringify({ error: 'content not found' }), etag: '', hlc: entry?.hlc ?? '', updatedAt: 0 };
    rt.cache.set(key, hit);
  }

  // Low-cardinality attributes only: service and cache result, not the full path.
  telemetry.annotate({ 'caas.service': key.service, 'caas.cache': headers.get('x-caas-cache') ?? 'MISS', 'caas.found': hit.found });
  telemetry.count(`Reads/${hit.found ? 'Found' : 'NotFound'}`);

  // The entry tag is set on 404s too, so creating the content later purges the cached 404.
  const cacheTags = [tags.group(cfg.group), tags.service(cfg.group, key.service), tags.entry(cfg.group, key)];
  headers.set('edge-cache-tag', cacheTags.join(','));

  if (!hit.found) {
    headers.set('cache-control', `public, max-age=0, s-maxage=${cfg.notFoundCdnMaxAge}`);
    headers.set('edge-control', `cache-maxage=${cfg.notFoundCdnMaxAge}s`);
    return new Response(hit.body, { status: 404, headers });
  }

  headers.set(
    'cache-control',
    `public, max-age=${cfg.browserMaxAge}, s-maxage=${cfg.cdnMaxAge}, stale-while-revalidate=${cfg.staleWhileRevalidate}`,
  );
  // Akamai-specific TTL; the browser TTL above stays short because browsers cannot be purged.
  headers.set('edge-control', `cache-maxage=${cfg.cdnMaxAge}s`);
  headers.set('etag', hit.etag);
  headers.set('x-caas-version', hit.hlc);
  if (hit.updatedAt > 0) headers.set('last-modified', new Date(hit.updatedAt).toUTCString());

  if (etagMatches(req.headers.get('if-none-match'), hit.etag)) {
    headers.delete('content-type');
    return new Response(null, { status: 304, headers });
  }
  return new Response(hit.body, { status: 200, headers });
}
