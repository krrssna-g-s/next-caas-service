/** Admin token checks and the diagnostics that never reveal a token. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { authenticateAdmin, describeAdminTokens, presentedAdminToken, tokenFingerprint } from '../lib/caas/auth';
import { loadConfig } from '../lib/caas/config';

const TOKEN = 'a'.repeat(16) + '0123456789abcdef0123456789abcdef';
const cfg = loadConfig({ CAAS_ADMIN_TOKENS: `me:${TOKEN},bot:${'b'.repeat(20)}` });
const req = (headers: Record<string, string>) => new Request('http://x/api/caas-admin/status', { headers });

test('accepts the token in either header, rejects the name:token form', () => {
  assert.equal(authenticateAdmin(cfg, req({ authorization: `Bearer ${TOKEN}` })), 'me');
  assert.equal(authenticateAdmin(cfg, req({ 'x-caas-admin-token': TOKEN })), 'me');
  assert.equal(authenticateAdmin(cfg, req({ authorization: `Bearer me:${TOKEN}` })), undefined);
  assert.equal(authenticateAdmin(cfg, req({})), undefined);
});

test('fingerprints match shasum and never contain the token', () => {
  const fp = tokenFingerprint(TOKEN);
  assert.equal(fp, createHash('sha256').update(TOKEN).digest('hex').slice(0, 8));
  const described = describeAdminTokens(cfg);
  assert.equal(described, `me (${TOKEN.length} chars, fingerprint ${fp}), bot (20 chars, fingerprint ${tokenFingerprint('b'.repeat(20))})`);
  assert.ok(!described.includes(TOKEN));
});

test('reports which header carried the presented token', () => {
  assert.deepEqual(presentedAdminToken(req({ authorization: 'Bearer abc' })), { token: 'abc', header: 'authorization' });
  assert.deepEqual(presentedAdminToken(req({ 'x-caas-admin-token': 'xyz' })), { token: 'xyz', header: 'x-caas-admin-token' });
  assert.deepEqual(presentedAdminToken(req({ authorization: 'Basic abc' })), { header: 'authorization (not "Bearer <token>")' });
  assert.deepEqual(presentedAdminToken(req({})), {});
});
