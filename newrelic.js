'use strict';
/**
 * New Relic Node agent configuration (hybrid agent for Next.js 16).
 *
 * Contains no secrets. The license key and app name come from
 * NEW_RELIC_LICENSE_KEY / NEW_RELIC_APP_NAME, set as environment variables
 * or in global.properties (new.relic.license.key=..., prod.new.relic.app.name=...).
 * Any NEW_RELIC_* environment variable overrides the matching value here.
 * The agent is only started when a license key is present (instrumentation.ts).
 */
exports.config = {
  app_name: ['caas-service'],
  // Next.js 16 emits OpenTelemetry spans for every request; the hybrid agent
  // turns them into transactions, so the agent's own http / next / undici
  // instrumentation is switched off to avoid duplicate spans.
  opentelemetry: { enabled: true },
  instrumentation: {
    http: { enabled: false },
    next: { enabled: false },
    undici: { enabled: false },
  },
  distributed_tracing: { enabled: true },
  logging: { level: 'info', filepath: 'stdout' },
  application_logging: {
    forwarding: { enabled: true },
    // Log lines from the service are sent with recordLogEvent (lib/caas/telemetry.ts).
    local_decorating: { enabled: false },
  },
  // Kubernetes probes run every few seconds on every pod; they are not traffic.
  rules: { ignore: ['^/api/health/'] },
  error_collector: {
    // 4xx are caller mistakes (bad token, invalid JSON, edit conflict) and are
    // counted as Custom/CaaS/* metrics instead of being reported as errors.
    ignore_status_codes: ['400-499'],
  },
  // Never send credentials: admin tokens, pod-to-pod signatures, cookies.
  // Header attributes are matched in camelCase form.
  attributes: {
    exclude: [
      'request.headers.authorization',
      'request.headers.cookie',
      'request.headers.proxyAuthorization',
      'request.headers.xCaasAdminToken',
      'request.headers.xCaasSignature',
      'request.headers.x-caas-admin-token',
      'request.headers.x-caas-signature',
      'response.headers.setCookie*',
      'http.request.header.authorization',
      'http.request.header.x_caas_admin_token',
      'http.request.header.x_caas_signature',
      'http.request.header.cookie',
    ],
  },
};
