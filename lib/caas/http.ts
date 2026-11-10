/** Small helpers shared by the route handlers. Only Web-standard Request/Response are used. */
import { authenticateAdmin, describeAdminTokens, presentedAdminToken, tokenFingerprint } from './auth';
import { stringifyForHtml } from './json-tools';
import { telemetry } from './telemetry';
import { log, type Runtime } from './runtime';

/**
 * Sent with every API response. A JSON response opened directly in a browser
 * can then never be sniffed as HTML, run script, or be framed.
 */
export const API_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-site',
};

const NO_STORE = { 'cache-control': 'no-store' };

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(stringifyForHtml(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...API_SECURITY_HEADERS, ...NO_STORE, ...headers },
  });
}

export function problem(status: number, error: string, extra: Record<string, unknown> = {}): Response {
  telemetry.count(`Responses/${status}`);
  return json({ error, ...extra }, status);
}

/** Returns the actor name, or the Response to send back when the caller is not allowed. */
export function requireAdmin(rt: Runtime, req: Request): string | Response {
  if (rt.config.adminTokens.size === 0) return problem(503, 'admin API is not configured (CAAS_ADMIN_TOKENS)');
  const actor = authenticateAdmin(rt.config, req);
  if (!actor) {
    telemetry.count('Admin/AuthFailed');
    logRejection(rt, req);
    return problem(401, 'missing or invalid admin token', {});
  }
  // The actor name, never the token.
  telemetry.annotate({ 'caas.actor': actor });
  return actor;
}

let lastRejectionLog = 0;

/**
 * Says in the server log why a token was refused, with fingerprints instead
 * of tokens, at most once every 5 s so a flood of bad requests cannot flood the log.
 */
function logRejection(rt: Runtime, req: Request): void {
  const now = Date.now();
  if (now - lastRejectionLog < 5_000) return;
  lastRejectionLog = now;
  const { token, header } = presentedAdminToken(req);
  const presented = token
    ? `presented ${token.length} chars, fingerprint ${tokenFingerprint(token)} (header ${header})`
    : header
      ? `header ${header}`
      : 'no token presented';
  log(
    rt.config,
    `admin token rejected: ${presented}; this server accepts ${describeAdminTokens(rt.config)} from ${rt.config.adminTokensSource}`,
    'warn',
  );
}

/** Reads the body as text, refusing anything over the limit. */
export async function readBody(req: Request, maxBytes: number): Promise<string | Response> {
  const declared = Number(req.headers.get('content-length') ?? 0);
  if (declared > maxBytes) return problem(413, `body exceeds ${maxBytes} bytes`);
  const text = await req.text();
  if (Buffer.byteLength(text) > maxBytes) return problem(413, `body exceeds ${maxBytes} bytes`);
  return text;
}

export function parseJson<T = unknown>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

/** RFC 9110 If-None-Match / If-Match comparison (weak comparison). */
export function etagMatches(header: string | null, etag: string): boolean {
  if (!header) return false;
  if (header.trim() === '*') return true;
  const strip = (t: string) => t.trim().replace(/^W\//, '');
  return header.split(',').some((t) => strip(t) === strip(etag));
}
