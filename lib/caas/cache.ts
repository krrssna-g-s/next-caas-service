/**
 * In-memory response cache for the public content route. It sits in front of
 * SQLite and is invalidated by the store's change listener, so it is cleared
 * on every pod as soon as that pod applies an update, whether the update was
 * written locally or arrived through replication.
 */
import type { ContentKey } from './store';

export interface CachedResponse {
  found: boolean;
  body: string;
  etag: string;
  hlc: string;
  updatedAt: number;
}

export class ResponseCache {
  private readonly map = new Map<string, CachedResponse>();

  constructor(private readonly maxEntries: number) {}

  private static k(key: ContentKey): string {
    return `${key.service}\n${key.path}`;
  }

  get(key: ContentKey): CachedResponse | undefined {
    const k = ResponseCache.k(key);
    const hit = this.map.get(k);
    if (hit) {
      // Re-insert so the Map's insertion order doubles as LRU order.
      this.map.delete(k);
      this.map.set(k, hit);
    }
    return hit;
  }

  set(key: ContentKey, value: CachedResponse): void {
    const k = ResponseCache.k(key);
    this.map.delete(k);
    this.map.set(k, value);
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  invalidate(key: ContentKey): void {
    this.map.delete(ResponseCache.k(key));
  }

  /** Clears one service, or everything when no service is given. */
  clear(service?: string): void {
    if (!service) {
      this.map.clear();
      return;
    }
    const prefix = `${service}\n`;
    for (const k of [...this.map.keys()]) if (k.startsWith(prefix)) this.map.delete(k);
  }

  get size(): number {
    return this.map.size;
  }
}
