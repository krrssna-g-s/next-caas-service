/**
 * Content store on top of the embedded database.
 *
 * One row per (service, path). Each row carries an HLC version; a row is only
 * replaced by a row with a higher version, which is what makes replication
 * between pods converge. Deletes are kept as tombstones so that a pod that was
 * offline cannot bring deleted content back.
 */
import { createHash } from 'node:crypto';
import type { Database, Row, Statement } from './db';
import { HybridClock, formatHlc } from './hlc';
import { normalizeKey, type ContentKey } from './keys';

export interface Entry {
  service: string;
  path: string;
  /** Minified JSON text; empty for tombstones. */
  body: string;
  etag: string;
  hlc: string;
  deleted: boolean;
  updatedBy: string;
  updatedAt: number;
}

export type EntryMeta = Omit<Entry, 'body'>;
export type DigestItem = [service: string, path: string, hlc: string];
export type { ContentKey } from './keys';
export { normalizeKey } from './keys';

export function etagFor(body: string): string {
  return `"${createHash('sha256').update(body).digest('base64url').slice(0, 22)}"`;
}

export function toMeta(e: Entry): EntryMeta {
  const { body: _body, ...meta } = e;
  return meta;
}

function fromRow(r: Row): Entry {
  return {
    service: r.service as string,
    path: r.path as string,
    body: r.body as string,
    etag: r.etag as string,
    hlc: r.hlc as string,
    deleted: Number(r.deleted) === 1,
    updatedBy: r.updated_by as string,
    updatedAt: Number(r.updated_at),
  };
}

/** Checks a row received from another pod before it is trusted. */
export function isValidEntry(e: unknown): e is Entry {
  if (!e || typeof e !== 'object') return false;
  const x = e as Record<string, unknown>;
  if (typeof x.service !== 'string' || typeof x.path !== 'string') return false;
  const key = normalizeKey(x.service, x.path);
  if (!key || key.service !== x.service || key.path !== x.path) return false;
  return (
    typeof x.body === 'string' &&
    typeof x.etag === 'string' &&
    typeof x.hlc === 'string' &&
    /^\d{13}-[0-9a-f]{4}-.{1,200}$/.test(x.hlc) &&
    typeof x.deleted === 'boolean' &&
    typeof x.updatedBy === 'string' &&
    typeof x.updatedAt === 'number'
  );
}

export class ContentStore {
  private readonly listeners: Array<(e: Entry) => void> = [];
  private cachedHash: string | undefined;
  private readonly q: Record<
    'get' | 'upsert' | 'addHistory' | 'pruneHistory' | 'digest' | 'count' | 'maxHlc' | 'history' | 'historyOne',
    Statement
  >;

  constructor(
    private readonly db: Database,
    private readonly clock: HybridClock,
    private readonly historyLimit = 20,
  ) {
    this.q = {
      get: db.prepare('SELECT * FROM entries WHERE service = ? AND path = ?'),
      upsert: db.prepare(
        `INSERT INTO entries (service, path, body, etag, hlc, deleted, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (service, path) DO UPDATE SET
           body = excluded.body, etag = excluded.etag, hlc = excluded.hlc, deleted = excluded.deleted,
           updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      ),
      addHistory: db.prepare(
        `INSERT OR IGNORE INTO history (service, path, hlc, body, etag, deleted, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      pruneHistory: db.prepare(
        `DELETE FROM history WHERE service = ?1 AND path = ?2 AND hlc NOT IN
           (SELECT hlc FROM history WHERE service = ?1 AND path = ?2 ORDER BY hlc DESC LIMIT ?3)`,
      ),
      digest: db.prepare('SELECT service, path, hlc FROM entries ORDER BY service, path'),
      count: db.prepare('SELECT COUNT(*) AS n FROM entries WHERE deleted = 0'),
      maxHlc: db.prepare('SELECT MAX(hlc) AS hlc FROM entries'),
      history: db.prepare(
        `SELECT service, path, hlc, etag, deleted, updated_by, updated_at, '' AS body
         FROM history WHERE service = ? AND path = ? ORDER BY hlc DESC`,
      ),
      historyOne: db.prepare('SELECT * FROM history WHERE service = ? AND path = ? AND hlc = ?'),
    };
    // After a restart the clock must not issue versions below what is already on disk.
    const max = this.q.maxHlc.get()?.hlc;
    if (typeof max === 'string') this.clock.observe(max);
  }

  onChange(listener: (e: Entry) => void): void {
    this.listeners.push(listener);
  }

  get(key: ContentKey): Entry | undefined {
    const row = this.q.get.get(key.service, key.path);
    return row ? fromRow(row) : undefined;
  }

  getMany(keys: ContentKey[]): Entry[] {
    const out: Entry[] = [];
    for (const k of keys) {
      const e = this.get(k);
      if (e) out.push(e);
    }
    return out;
  }

  list(opts: { service?: string; prefix?: string; includeDeleted?: boolean } = {}): EntryMeta[] {
    const where: string[] = [];
    const params: string[] = [];
    if (opts.service) {
      where.push('service = ?');
      params.push(opts.service);
    }
    if (opts.prefix) {
      where.push(`path LIKE ? ESCAPE '\\'`);
      params.push(opts.prefix.replace(/[\\%_]/g, (c) => `\\${c}`) + '%');
    }
    if (!opts.includeDeleted) where.push('deleted = 0');
    const sql =
      `SELECT service, path, etag, hlc, deleted, updated_by, updated_at, '' AS body FROM entries` +
      (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
      ' ORDER BY service, path';
    return this.db
      .prepare(sql)
      .all(...params)
      .map((r) => toMeta(fromRow(r)));
  }

  /** Every entry including bodies, for export. */
  exportAll(): Entry[] {
    return this.db.prepare('SELECT * FROM entries WHERE deleted = 0 ORDER BY service, path').all().map(fromRow);
  }

  count(): number {
    return Number(this.q.count.get()?.n ?? 0);
  }

  /** Local write: create or replace content. `json` must already be valid JSON text. */
  put(key: ContentKey, json: string, updatedBy: string): Entry {
    const body = JSON.stringify(JSON.parse(json));
    return this.writeLocal(key, body, false, updatedBy);
  }

  /** Local delete: writes a tombstone. */
  remove(key: ContentKey, updatedBy: string): Entry {
    return this.writeLocal(key, '', true, updatedBy);
  }

  private writeLocal(key: ContentKey, body: string, deleted: boolean, updatedBy: string): Entry {
    const entry: Entry = {
      service: key.service,
      path: key.path,
      body,
      etag: deleted ? '""' : etagFor(body),
      hlc: this.clock.next(),
      deleted,
      updatedBy,
      updatedAt: Date.now(),
    };
    this.transaction(() => this.write(entry));
    this.notify([entry]);
    return entry;
  }

  /**
   * Applies rows that came from another pod (or from the seed directory).
   * Returns only the rows that were actually newer than what this pod had.
   */
  applyRemote(entries: Entry[]): Entry[] {
    const applied: Entry[] = [];
    this.transaction(() => {
      for (const e of entries) {
        this.clock.observe(e.hlc);
        const current = this.q.get.get(e.service, e.path);
        if (current && (current.hlc as string) >= e.hlc) continue;
        this.write(e);
        applied.push(e);
      }
    });
    this.notify(applied);
    return applied;
  }

  /** Seed rows use a version far below any real timestamp, so a runtime edit always wins. */
  seedEntry(key: ContentKey, json: string, seedVersion: number): Entry {
    const body = JSON.stringify(JSON.parse(json));
    return {
      ...key,
      body,
      etag: etagFor(body),
      hlc: formatHlc(seedVersion, 0, 'seed'),
      deleted: false,
      updatedBy: 'seed',
      updatedAt: 0,
    };
  }

  history(key: ContentKey): EntryMeta[] {
    return this.q.history.all(key.service, key.path).map((r) => toMeta(fromRow(r)));
  }

  historyVersion(key: ContentKey, hlc: string): Entry | undefined {
    const row = this.q.historyOne.get(key.service, key.path, hlc);
    return row ? fromRow(row) : undefined;
  }

  digest(): DigestItem[] {
    return this.q.digest.all().map((r) => [r.service as string, r.path as string, r.hlc as string]);
  }

  /** Two pods with the same hash hold exactly the same versions of everything. */
  stateHash(): string {
    if (this.cachedHash !== undefined) return this.cachedHash;
    const h = createHash('sha256');
    for (const [s, p, v] of this.digest()) h.update(`${s}\n${p}\n${v}\n`);
    const hash = h.digest('hex');
    this.cachedHash = hash;
    return hash;
  }

  private write(e: Entry): void {
    const del = e.deleted ? 1 : 0;
    this.q.upsert.run(e.service, e.path, e.body, e.etag, e.hlc, del, e.updatedBy, e.updatedAt);
    this.q.addHistory.run(e.service, e.path, e.hlc, e.body, e.etag, del, e.updatedBy, e.updatedAt);
    this.q.pruneHistory.run(e.service, e.path, this.historyLimit);
  }

  private transaction(fn: () => void): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      fn();
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  private notify(entries: Entry[]): void {
    if (entries.length === 0) return;
    this.cachedHash = undefined;
    for (const e of entries) for (const l of this.listeners) l(e);
  }
}
