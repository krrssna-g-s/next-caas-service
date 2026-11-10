/**
 * Hybrid logical clock. Every write gets a version string that sorts
 * lexicographically in "happened later" order across all pods, even when
 * their wall clocks differ slightly:
 *
 *   <13-digit ms>-<4-hex counter>-<node id>
 *
 * Replication is last-writer-wins on this version.
 */
const MAX_COUNTER = 0xffff;

export function formatHlc(ms: number, counter: number, nodeId: string): string {
  return `${String(ms).padStart(13, '0')}-${counter.toString(16).padStart(4, '0')}-${nodeId}`;
}

export function parseHlc(hlc: string): { ms: number; counter: number } | undefined {
  const m = /^(\d{13})-([0-9a-f]{4})-.+$/.exec(hlc);
  if (!m) return undefined;
  return { ms: Number(m[1]), counter: parseInt(m[2], 16) };
}

export class HybridClock {
  private ms = 0;
  private counter = 0;

  constructor(
    private readonly nodeId: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** Version for a new local write; always greater than anything this pod has seen. */
  next(): string {
    const wall = this.now();
    if (wall > this.ms) {
      this.ms = wall;
      this.counter = 0;
    } else if (this.counter < MAX_COUNTER) {
      this.counter += 1;
    } else {
      this.ms += 1;
      this.counter = 0;
    }
    return formatHlc(this.ms, this.counter, this.nodeId);
  }

  /** Call for every version received from another pod (and for rows loaded at startup). */
  observe(hlc: string): void {
    const parsed = parseHlc(hlc);
    if (!parsed) return;
    if (parsed.ms > this.ms || (parsed.ms === this.ms && parsed.counter > this.counter)) {
      this.ms = parsed.ms;
      this.counter = parsed.counter;
    }
  }
}
