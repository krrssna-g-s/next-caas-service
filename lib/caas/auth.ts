/**
 * Two kinds of callers are authenticated here:
 *  - content editors / release tooling calling the admin API with a token
 *  - other pods calling the internal sync API with an HMAC signature
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { CaasConfig } from './config';

const sha256 = (s: string) => createHash('sha256').update(s).digest();

/** Returns the actor name for a valid admin token, otherwise undefined. */
export function authenticateAdmin(cfg: CaasConfig, req: Request): string | undefined {
  // x-caas-admin-token exists because some gateways consume the Authorization header themselves.
  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') ?? '')?.[1];
  const presented = req.headers.get('x-caas-admin-token') ?? bearer;
  if (!presented) return undefined;
  const presentedHash = sha256(presented);
  let actor: string | undefined;
  for (const [token, name] of cfg.adminTokens) {
    if (timingSafeEqual(sha256(token), presentedHash)) actor = name;
  }
  return actor;
}

const SIGNATURE_HEADER = 'x-caas-signature';
const MAX_SKEW_MS = 60_000;

function mac(cfg: CaasConfig, ts: string, method: string, action: string, body: string): string {
  // The action name is signed rather than the URL so the signature survives path rewrites in proxies.
  const payload = [ts, cfg.group, method.toUpperCase(), action, createHash('sha256').update(body).digest('hex')].join('.');
  return createHmac('sha256', cfg.syncSecret).update(payload).digest('hex');
}

export function signSync(cfg: CaasConfig, method: string, action: string, body: string): Record<string, string> {
  const ts = String(Date.now());
  return {
    [SIGNATURE_HEADER]: `t=${ts},s=${mac(cfg, ts, method, action, body)}`,
    'x-caas-node': cfg.nodeId,
    'x-caas-group': cfg.group,
  };
}

export function verifySync(cfg: CaasConfig, req: Request, action: string, body: string): boolean {
  if (!cfg.syncSecret) return false;
  const m = /^t=(\d+),s=([0-9a-f]{64})$/.exec(req.headers.get(SIGNATURE_HEADER) ?? '');
  if (!m) return false;
  if (Math.abs(Date.now() - Number(m[1])) > MAX_SKEW_MS) return false;
  const expected = Buffer.from(mac(cfg, m[1], req.method, action, body), 'hex');
  return timingSafeEqual(expected, Buffer.from(m[2], 'hex'));
}
