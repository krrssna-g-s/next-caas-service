/**
 * Thin wrapper around the New Relic agent. Every function is a no-op until
 * instrumentation.ts has started the agent, so local runs and tests need no
 * license key and nothing here can break a request.
 *
 * What is reported (all names start with Custom/CaaS or CaaS):
 *  - errors: unhandled route errors (onRequestError), CDN purge failures,
 *    pods that did not acknowledge a write, anti-entropy failures;
 *  - events: CaasPublish (one per write: entries, pods ok/failed, CDN result,
 *    duration), CaasHealth (per pod, every sync interval);
 *  - metrics: content reads by cache HIT/MISS/404, admin auth failures,
 *    refused writes, sanitized values, replication failures;
 *  - logs: every service log line (recordLogEvent).
 * Credentials and content bodies are never sent.
 */

export interface NewRelicApi {
  noticeError(error: Error, attributes?: Record<string, string | number | boolean>, expected?: boolean): void;
  recordMetric(name: string, value: number): void;
  incrementMetric(name: string, value?: number): void;
  recordCustomEvent(type: string, attributes: Record<string, string | number | boolean>): void;
  addCustomAttributes(attributes: Record<string, string | number | boolean>): void;
  recordLogEvent(event: { message: string; level?: string; error?: Error }): void;
}

const key = Symbol.for('caas.newrelic');
type G = typeof globalThis & { [key]?: NewRelicApi };

export function setAgent(api: NewRelicApi | undefined): void {
  (globalThis as G)[key] = api;
}

function agent(): NewRelicApi | undefined {
  return (globalThis as G)[key];
}

export function telemetryEnabled(): boolean {
  return agent() !== undefined;
}

/** Runs fn against the agent; telemetry must never throw into a request. */
function safe(fn: (nr: NewRelicApi) => void): void {
  const nr = agent();
  if (!nr) return;
  try {
    fn(nr);
  } catch {
    // ignore
  }
}

type Attrs = Record<string, string | number | boolean | undefined>;
const clean = (a: Attrs) => Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined)) as Record<string, string | number | boolean>;

export const telemetry = {
  error(err: unknown, attrs: Attrs = {}): void {
    safe((nr) => nr.noticeError(err instanceof Error ? err : new Error(String(err)), clean(attrs)));
  },
  count(name: string, by = 1): void {
    safe((nr) => nr.incrementMetric(`Custom/CaaS/${name}`, by));
  },
  gauge(name: string, value: number): void {
    safe((nr) => nr.recordMetric(`Custom/CaaS/${name}`, value));
  },
  event(type: string, attrs: Attrs): void {
    safe((nr) => nr.recordCustomEvent(type, clean(attrs)));
  },
  /** Attributes on the current transaction (shows up on traces and errors). */
  annotate(attrs: Attrs): void {
    safe((nr) => nr.addCustomAttributes(clean(attrs)));
  },
  log(message: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    safe((nr) => nr.recordLogEvent({ message, level }));
  },
};
