/** Typed calls to the admin API, used by the console. The token is passed in, never stored. */
import type { Json } from '@/lib/caas/json-tools';

export interface EntryMeta {
  service: string;
  path: string;
  etag: string;
  hlc: string;
  deleted: boolean;
  updatedBy: string;
  updatedAt: number;
}

export interface PublishReport {
  replication?: Array<{ url: string; scope: string; ok: boolean; error?: string }>;
  pods?: Array<{ url: string; scope: string; ok: boolean; error?: string }>;
  cdn?: { status: 'ok' | 'skipped' | 'error'; detail?: string };
  sanitized?: Array<{ pointer: string; reason: string; index?: number }>;
}

export interface Status {
  node: string;
  env: string;
  zone: string;
  group: string;
  entries: number;
  peers: Array<{ url: string; node?: string; scope: string; inSync: boolean; lastError?: string }>;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly data: Record<string, unknown>,
  ) {
    super(message);
  }
}

export interface Api {
  status(): Promise<Status>;
  list(service?: string): Promise<{ services: string[]; entries: EntryMeta[] }>;
  read(service: string, path: string): Promise<{ entry: EntryMeta; content: Json; etag: string | null }>;
  history(service: string, path: string): Promise<{ versions: EntryMeta[] }>;
  version(service: string, path: string, hlc: string): Promise<{ entry: EntryMeta; content: Json | null }>;
  save(
    service: string,
    path: string,
    content: Json,
    opts: { ifMatch?: string | null; createOnly?: boolean },
  ): Promise<PublishReport & { entry: EntryMeta; etag: string | null }>;
  remove(service: string, path: string, ifMatch?: string | null): Promise<PublishReport>;
  rollback(service: string, path: string, hlc: string): Promise<PublishReport>;
  purge(scope: { service?: string; path?: string }): Promise<PublishReport>;
  importBulk(
    entries: Array<{ service: string; path: string; content: Json }>,
    mode: 'upsert' | 'create',
  ): Promise<PublishReport & { imported: number }>;
}

export function entryUrl(service: string, path: string): string {
  const segments = path.split('/').filter(Boolean).map(encodeURIComponent);
  return `/api/caas-admin/content/${encodeURIComponent(service)}/${segments.join('/')}`;
}

export function createApi(token: string): Api {
  const call = async <T,>(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(url, {
      method,
      // Same-origin only, and never send cookies: the token header is the only credential.
      credentials: 'omit',
      cache: 'no-store',
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new ApiError(typeof data.error === 'string' ? data.error : `HTTP ${res.status}`, res.status, data);
    return { data: data as T, res };
  };

  return {
    status: async () => (await call<Status>('GET', '/api/caas-admin/status')).data,
    list: async (service) =>
      (await call<{ services: string[]; entries: EntryMeta[] }>(
        'GET',
        '/api/caas-admin/content' + (service ? `?service=${encodeURIComponent(service)}` : ''),
      )).data,
    read: async (service, path) => {
      const { data, res } = await call<{ entry: EntryMeta; content: Json }>('GET', entryUrl(service, path));
      return { ...data, etag: res.headers.get('etag') };
    },
    history: async (service, path) => (await call<{ versions: EntryMeta[] }>('GET', `${entryUrl(service, path)}?history=1`)).data,
    version: async (service, path, hlc) =>
      (await call<{ entry: EntryMeta; content: Json | null }>('GET', `${entryUrl(service, path)}?version=${encodeURIComponent(hlc)}`)).data,
    save: async (service, path, content, { ifMatch, createOnly }) => {
      const headers: Record<string, string> = {};
      if (createOnly) headers['if-none-match'] = '*';
      else if (ifMatch) headers['if-match'] = ifMatch;
      const { data, res } = await call<PublishReport & { entry: EntryMeta }>('PUT', entryUrl(service, path), content, headers);
      return { ...data, etag: res.headers.get('etag') };
    },
    remove: async (service, path, ifMatch) =>
      (await call<PublishReport>('DELETE', entryUrl(service, path), undefined, ifMatch ? { 'if-match': ifMatch } : {})).data,
    rollback: async (service, path, hlc) => (await call<PublishReport>('POST', entryUrl(service, path), { rollbackTo: hlc })).data,
    purge: async (scope) => (await call<PublishReport>('POST', '/api/caas-admin/purge', scope)).data,
    importBulk: async (entries, mode) =>
      (await call<PublishReport & { imported: number }>('POST', `/api/caas-admin/transfer?mode=${mode}`, { entries })).data,
  };
}

/** One-line summary of how a write was replicated and purged. */
export function describeReport(r: PublishReport): { text: string; ok: boolean } {
  const pods = r.replication ?? r.pods ?? [];
  const acked = pods.filter((p) => p.ok).length;
  const cdn = r.cdn ? r.cdn.status + (r.cdn.status === 'error' && r.cdn.detail ? ` (${r.cdn.detail})` : '') : 'n/a';
  const parts = [`pods acknowledged ${acked}/${pods.length}`, `CDN purge ${cdn}`];
  if (r.sanitized?.length) parts.push(`${r.sanitized.length} value(s) sanitized`);
  return { text: parts.join(' · '), ok: acked === pods.length && r.cdn?.status !== 'error' };
}
