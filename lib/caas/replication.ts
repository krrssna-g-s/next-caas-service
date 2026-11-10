/**
 * Keeps the embedded databases of all pods identical.
 *
 *  1. Push on write. The pod that receives an admin write sends the new rows
 *     to every pod in its own cluster and to one endpoint of each other zone;
 *     the pod that receives it there relays it to its own cluster.
 *  2. Anti-entropy. Every pod periodically compares a hash of its state with
 *     each peer and pulls whatever it is missing. This repairs pods that were
 *     down, unreachable or just scaled up.
 *  3. Bootstrap. A starting pod pulls from its peers before it reports ready,
 *     so a scaled-up pod never serves old content.
 *
 * Conflicts are resolved last-writer-wins on the HLC version of each row.
 */
import { telemetry } from './telemetry';
import { promises as dns } from 'node:dns';
import { signSync } from './auth';
import type { CaasConfig } from './config';
import type { ContentKey, ContentStore, DigestItem, Entry } from './store';

export type Hop = 'relay' | 'final';
type Scope = 'local' | 'remote';

export interface PeerStatus {
  url: string;
  scope: Scope;
  node?: string;
  inSync?: boolean;
  lastOkAt?: number;
  lastError?: string;
}

export interface PushResult {
  url: string;
  scope: Scope;
  ok: boolean;
  error?: string;
}

export interface PurgeScope {
  service?: string;
  path?: string;
}

const PULL_CHUNK = 200;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Replicator {
  private readonly peers = new Map<string, PeerStatus>();
  private readonly selfUrls = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private running: Promise<void> | undefined;

  constructor(
    private readonly cfg: CaasConfig,
    private readonly store: ContentStore,
    private readonly log: (msg: string) => void = () => {},
  ) {}

  get enabled(): boolean {
    return this.cfg.syncSecret !== '';
  }

  status(): PeerStatus[] {
    return [...this.peers.values()];
  }

  // ---- peer discovery -----------------------------------------------------

  /** Pods of this cluster come from the headless service DNS record; other zones from config. */
  private async discover(): Promise<PeerStatus[]> {
    const found = new Map<string, Scope>();
    for (const name of this.cfg.peerDns) {
      try {
        // lookup() goes through the system resolver, so short in-cluster names work too.
        for (const { address } of await dns.lookup(name, { all: true, family: 4 })) {
          if (address !== this.cfg.podIp) found.set(`http://${address}:${this.cfg.peerPort}`, 'local');
        }
      } catch {
        // No record yet (first pod of the cluster, or DNS not updated): treated as "no peers".
      }
    }
    for (const url of this.cfg.staticPeers) found.set(url, 'local');
    for (const url of this.cfg.remotePeers) if (!found.has(url)) found.set(url, 'remote');

    for (const url of [...this.peers.keys()]) if (!found.has(url)) this.peers.delete(url);
    for (const [url, scope] of found) {
      if (this.selfUrls.has(url)) continue;
      if (!this.peers.has(url)) this.peers.set(url, { url, scope });
    }
    return [...this.peers.values()];
  }

  private async call<T>(peer: PeerStatus, method: 'GET' | 'POST', action: string, query = '', payload?: unknown): Promise<T> {
    const body = payload === undefined ? '' : JSON.stringify(payload);
    const res = await fetch(`${peer.url}/api/internal/sync/${action}${query}`, {
      method,
      headers: { ...signSync(this.cfg, method, action, body), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body || undefined,
      signal: AbortSignal.timeout(this.cfg.pushTimeoutMs),
    });
    if (!res.ok) throw new Error(`${action} -> HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  /** POSTs to every peer in the given scopes. A peer that turns out to be this pod is dropped. */
  private async fanOut(action: 'push' | 'purge', payload: object, scopes: Scope[]): Promise<PushResult[]> {
    const targets = (await this.discover()).filter((p) => scopes.includes(p.scope));
    const results = await Promise.all(
      targets.map(async (peer): Promise<PushResult | undefined> => {
        const hop: Hop = peer.scope === 'remote' ? 'relay' : 'final';
        try {
          const res = await this.call<{ node?: string }>(peer, 'POST', action, '', { ...payload, hop });
          if (res.node === this.cfg.nodeId) {
            this.selfUrls.add(peer.url);
            this.peers.delete(peer.url);
            return undefined;
          }
          peer.node = res.node ?? peer.node;
          peer.lastOkAt = Date.now();
          peer.lastError = undefined;
          return { url: peer.url, scope: peer.scope, ok: true };
        } catch (err) {
          peer.lastError = (err as Error).message;
          peer.inSync = false;
          telemetry.count(`Replication/${action === 'push' ? 'PushFailed' : 'PurgeFanOutFailed'}`);
          return { url: peer.url, scope: peer.scope, ok: false, error: peer.lastError };
        }
      }),
    );
    return results.filter((r): r is PushResult => r !== undefined);
  }

  // ---- push on write ------------------------------------------------------

  /** Sends freshly written rows to every peer and waits (bounded) for their acknowledgement. */
  async broadcast(entries: Entry[], scopes: Scope[] = ['local', 'remote']): Promise<PushResult[]> {
    if (!this.enabled || entries.length === 0) return [];
    return this.fanOut('push', { entries }, scopes);
  }

  /** Called by the sync route when another pod pushes rows to this one. */
  async handlePush(entries: Entry[], hop: Hop): Promise<{ applied: number; relayed: PushResult[] }> {
    const applied = this.store.applyRemote(entries);
    // Only rows that were news to this pod are relayed, and only one hop, so pushes cannot loop.
    const relayed = hop === 'relay' && applied.length > 0 ? await this.broadcast(applied, ['local']) : [];
    return { applied: applied.length, relayed };
  }

  /** Tells every pod to drop its in-memory response cache for a scope. */
  async broadcastPurge(scope: PurgeScope, scopes: Scope[] = ['local', 'remote']): Promise<PushResult[]> {
    if (!this.enabled) return [];
    return this.fanOut('purge', scope, scopes);
  }

  // ---- anti-entropy -------------------------------------------------------

  /** Pulls everything a peer has that is newer than the local copy. Returns the number of rows applied. */
  private async pullFrom(peer: PeerStatus): Promise<number> {
    const head = await this.call<{ node: string; stateHash: string }>(peer, 'GET', 'digest');
    peer.node = head.node;
    if (head.node === this.cfg.nodeId) {
      // A static peer list can include this pod itself.
      this.selfUrls.add(peer.url);
      this.peers.delete(peer.url);
      return 0;
    }
    let applied = 0;
    if (head.stateHash !== this.store.stateHash()) {
      const full = await this.call<{ entries: DigestItem[] }>(peer, 'GET', 'digest', '?full=1');
      const mine = new Map(this.store.digest().map(([s, p, h]) => [`${s}\n${p}`, h]));
      const need: ContentKey[] = [];
      for (const [service, path, hlc] of full.entries) {
        const local = mine.get(`${service}\n${path}`);
        if (local === undefined || local < hlc) need.push({ service, path });
      }
      for (let i = 0; i < need.length; i += PULL_CHUNK) {
        const res = await this.call<{ entries: Entry[] }>(peer, 'POST', 'pull', '', { keys: need.slice(i, i + PULL_CHUNK) });
        applied += this.store.applyRemote(res.entries).length;
      }
    }
    // False here means the peer still lacks rows this pod has; it fetches those in its own round.
    peer.inSync = head.stateHash === this.store.stateHash();
    peer.lastOkAt = Date.now();
    peer.lastError = undefined;
    return applied;
  }

  /** One round against all peers. Returns how many peers answered. */
  async syncOnce(): Promise<{ peers: number; reached: number; applied: number }> {
    if (!this.enabled) return { peers: 0, reached: 0, applied: 0 };
    const peers = await this.discover();
    let reached = 0;
    let applied = 0;
    await Promise.all(
      peers.map(async (peer) => {
        try {
          applied += await this.pullFrom(peer);
          if (!this.selfUrls.has(peer.url)) reached += 1;
        } catch (err) {
          peer.lastError = (err as Error).message;
          peer.inSync = false;
          telemetry.count('Replication/PullFailed');
        }
      }),
    );
    if (applied > 0) telemetry.count('Replication/RowsRepaired', applied);
    if (applied > 0) this.log(`anti-entropy applied ${applied} row(s)`);
    return { peers: this.peers.size, reached, applied };
  }

  /**
   * Runs before the pod reports ready. Resolves with the reason the pod was
   * allowed to start serving.
   */
  async bootstrap(): Promise<'replication-disabled' | 'no-peers' | 'synced' | 'timeout'> {
    if (!this.enabled) return 'replication-disabled';
    const deadline = Date.now() + this.cfg.bootstrapTimeoutMs;
    let emptyRounds = 0;
    for (;;) {
      const round = await this.syncOnce();
      if (round.reached > 0) return 'synced';
      if (round.peers === 0) {
        // Give DNS a moment before concluding this is the only pod.
        emptyRounds += 1;
        if (emptyRounds >= 3) return 'no-peers';
      }
      if (Date.now() >= deadline) return 'timeout';
      await sleep(Math.min(1_000, this.cfg.syncIntervalMs));
    }
  }

  start(): void {
    if (!this.enabled || this.timer || this.stopped) return;
    const schedule = () => {
      // Jitter keeps the pods from all syncing at the same instant.
      const delay = this.cfg.syncIntervalMs * (0.75 + Math.random() * 0.5);
      this.timer = setTimeout(() => {
        this.running = this.syncOnce()
          .then(() => undefined)
          .catch((err) => {
            this.log(`anti-entropy failed: ${(err as Error).message}`);
            telemetry.error(err, { 'caas.stage': 'anti-entropy' });
          })
          .finally(() => {
            if (!this.stopped) schedule();
          });
      }, delay);
      this.timer.unref?.();
    };
    schedule();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.running;
  }
}
