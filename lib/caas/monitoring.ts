/**
 * Starts the New Relic agent (hybrid agent for Next.js 16) from
 * instrumentation.ts, after the properties have been loaded, so its settings
 * can come from global.properties as well as from the environment:
 *
 *   new.relic.license.key=${NR_LICENSE_KEY}     (or NEW_RELIC_LICENSE_KEY env / Secret)
 *   prod.new.relic.app.name=caas-service-prod
 *
 * Nothing is started without a license key, or with NEW_RELIC_ENABLED=false.
 * Agent defaults (ignored probes, excluded credential headers, 4xx not
 * counted as errors) are in newrelic.js.
 */
import { loadEnvironment } from './properties';
import { setAgent, type NewRelicApi } from './telemetry';

const log = (msg: string) => console.log(JSON.stringify({ t: new Date().toISOString(), svc: 'caas', msg }));

export async function startMonitoring(): Promise<boolean> {
  const { env } = loadEnvironment(process.env);
  // The agent reads process.env itself; hand it NEW_RELIC_* values that came from the properties.
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith('NEW_RELIC_') && v !== undefined && process.env[k] === undefined) process.env[k] = v;
  }
  if (!process.env.NEW_RELIC_LICENSE_KEY || process.env.NEW_RELIC_ENABLED === 'false') {
    log('New Relic: not started (no NEW_RELIC_LICENSE_KEY, or NEW_RELIC_ENABLED=false)');
    return false;
  }

  const caasEnv = (env.CAAS_ENV ?? 'local').toLowerCase();
  const zone = (env.CAAS_ZONE ?? 'local').toLowerCase();
  // One app per environment; zone and environment as labels for faceting.
  process.env.NEW_RELIC_APP_NAME ??= `caas-service-${caasEnv}`;
  process.env.NEW_RELIC_LABELS ??= `env:${caasEnv};zone:${zone};group:${(env.CAAS_REPLICATION_GROUP ?? caasEnv).toLowerCase()}`;

  try {
    const mod = (await import('newrelic')) as unknown as { default?: NewRelicApi } & NewRelicApi;
    const api = (mod.default ?? mod) as NewRelicApi & { agent?: AgentLike };
    await waitForAgent(api.agent);
    setAgent(api);
    log(`New Relic: agent started as "${process.env.NEW_RELIC_APP_NAME}"`);
    return true;
  } catch (err) {
    // Monitoring must never keep the service from starting.
    log(`New Relic: agent failed to start: ${(err as Error).message}`);
    return false;
  }
}

interface AgentLike {
  _state?: string;
  once(event: string, fn: () => void): void;
}

/** Waits until the agent has connected (or given up), at most 8 s, as New Relic recommends. */
function waitForAgent(agent: AgentLike | undefined): Promise<void> {
  if (!agent || agent._state === 'started' || agent._state === 'errored') return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 8_000);
    timer.unref?.();
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    agent.once('started', done);
    agent.once('errored', done);
  });
}
