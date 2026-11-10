/**
 * Akamai cache control.
 *
 * Every public response carries Edge-Cache-Tag headers. When content changes,
 * the pod that received the write calls Akamai Fast Purge (CCU v3) for the
 * affected tags, so the CDN can hold content for a long TTL and still be
 * refreshed within seconds of an update.
 *
 * Requests are signed with Akamai EdgeGrid (EG1-HMAC-SHA256).
 */
import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { AkamaiConfig } from './config';
import type { ContentKey } from './store';

export interface PurgeResult {
  status: 'ok' | 'skipped' | 'error';
  tags: string[];
  detail?: string;
}

/** Tags use the replication group, so canary and prod (same content) are purged together. */
export const tags = {
  group: (group: string) => `caas-${group}`,
  service: (group: string, service: string) => `caas-${group}-${service}`,
  entry: (group: string, key: ContentKey) =>
    `caas-${group}-${key.service}-${createHash('sha1').update(key.path).digest('hex').slice(0, 16)}`,
};

function edgegridTimestamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}+0000`
  );
}

export function edgegridAuthHeader(cfg: AkamaiConfig, method: string, url: URL, body: string): string {
  const timestamp = edgegridTimestamp();
  const base =
    `EG1-HMAC-SHA256 client_token=${cfg.clientToken};access_token=${cfg.accessToken};` +
    `timestamp=${timestamp};nonce=${randomUUID()};`;
  const signingKey = createHmac('sha256', cfg.clientSecret).update(timestamp).digest('base64');
  const contentHash = method === 'POST' && body ? createHash('sha256').update(body).digest('base64') : '';
  const dataToSign = [
    method,
    url.protocol.replace(':', ''),
    url.host,
    url.pathname + url.search,
    '', // no signed headers
    contentHash,
    base,
  ].join('\t');
  const signature = createHmac('sha256', signingKey).update(dataToSign).digest('base64');
  return `${base}signature=${signature}`;
}

export class CdnPurger {
  constructor(
    private readonly akamai: AkamaiConfig | undefined,
    private readonly timeoutMs = 10_000,
  ) {}

  get configured(): boolean {
    return this.akamai !== undefined;
  }

  async purgeTags(tagList: string[]): Promise<PurgeResult> {
    const unique = [...new Set(tagList)];
    if (unique.length === 0) return { status: 'skipped', tags: unique, detail: 'nothing to purge' };
    if (!this.akamai) return { status: 'skipped', tags: unique, detail: 'Akamai credentials are not configured' };

    const cfg = this.akamai;
    const url = new URL(`${cfg.baseUrl}/ccu/v3/${cfg.mode}/tag/${cfg.network}`);
    const body = JSON.stringify({ objects: unique });
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: edgegridAuthHeader(cfg, 'POST', url, body),
        },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const text = await res.text();
      if (!res.ok) return { status: 'error', tags: unique, detail: `Akamai returned ${res.status}: ${text.slice(0, 300)}` };
      return { status: 'ok', tags: unique, detail: text.slice(0, 300) };
    } catch (err) {
      return { status: 'error', tags: unique, detail: (err as Error).message };
    }
  }
}
