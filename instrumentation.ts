/**
 * Next.js calls register() once when the server process starts, before it
 * serves any request:
 *   1. load global.properties (PROPS_PATH URL or file, or ./global.properties locally);
 *   2. start the New Relic agent when it is configured;
 *   3. open the embedded database, load the seed content and start replication.
 */
import type { Instrumentation } from 'next';

export async function register(): Promise<void> {
  // Keep this exact shape: Next.js also compiles this file for the edge runtime
  // and only drops the Node-only imports when they sit inside this condition.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { preloadProperties } = await import('./lib/caas/properties');
    try {
      await preloadProperties();
    } catch (err) {
      // Without its configuration the pod must not serve; exit so Kubernetes restarts it and the failure is visible.
      console.error(JSON.stringify({ t: new Date().toISOString(), svc: 'caas', msg: `startup failed: ${(err as Error).message}` }));
      process.exit(1);
    }
    const { startMonitoring } = await import('./lib/caas/monitoring');
    await startMonitoring();
    const { startRuntime } = await import('./lib/caas/runtime');
    startRuntime();
  }
}

/** Server errors Next.js caught in a route handler or page: reported to New Relic with the route. */
export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { telemetry } = await import('./lib/caas/telemetry');
  telemetry.error(error, {
    'caas.route': context.routePath,
    'caas.routeType': context.routeType,
    'request.method': request.method,
    // Path only: no query string, and never the headers (they carry admin tokens).
    'request.path': request.path.split('?')[0],
  });
  telemetry.count('Errors/Unhandled');
};
