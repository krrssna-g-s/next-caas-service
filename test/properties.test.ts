/** Tests for configuration from global.properties (properties-reader, PROPS_PATH file or URL). */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { loadConfig } from '../lib/caas/config';
import {
  loadEnvironment,
  preloadProperties,
  readPropertiesText,
  redactUrl,
  resetPreloadedProperties,
  resolveProperties,
  toEnvName,
} from '../lib/caas/properties';

const dirs: string[] = [];
const dirWith = (files: Record<string, string>) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'caas-props-')));
  dirs.push(d);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(d, name, '..'), { recursive: true });
    writeFileSync(join(d, name), text);
  }
  return d;
};
beforeEach(() => resetPreloadedProperties());
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

test('properties-reader output: comments, sections, raw string values', () => {
  const raw = readPropertiesText(['﻿a=1', '# comment', '', 'b = spaced value ', 'zero=0012', 'n=null', '[prod.west]', 'caas.x=y'].join('\r\n'));
  assert.deepEqual(Object.fromEntries(raw), { a: '1', b: 'spaced value', zero: '0012', n: 'null', 'prod.west.caas.x': 'y' });
});

test('dotted names map to environment variable names', () => {
  assert.equal(toEnvName('caas.cdn.max-age'), 'CAAS_CDN_MAX_AGE');
  assert.equal(toEnvName('CAAS_CDN_MAX_AGE'), 'CAAS_CDN_MAX_AGE');
  assert.equal(toEnvName('new.relic.license.key'), 'NEW_RELIC_LICENSE_KEY');
});

const FILE = [
  'CAAS_CDN_MAX_AGE=86400',
  'caas.browser.max.age=60',
  'sit.CAAS_CDN_MAX_AGE=300',
  'stage.only.here=1',
  '[prod]',
  'caas.cdn.max-age=7200',
  '[prod.west]',
  'CAAS_CDN_MAX_AGE=3600',
  'caas.remote.peers=https://east.example',
].join('\n');
const known = { envs: ['sit', 'stage', 'prod'], zones: ['east', 'west'] };

test('environment and zone (prefix or [section]) pick the most specific value', () => {
  const raw = readPropertiesText(FILE);
  const pick = (env: string, zone: string) => resolveProperties(raw, { CAAS_ENV: env, CAAS_ZONE: zone }, known).values;
  assert.equal(pick('sit', 'east').CAAS_CDN_MAX_AGE, '300');
  assert.equal(pick('prod', 'east').CAAS_CDN_MAX_AGE, '7200');
  assert.equal(pick('prod', 'west').CAAS_CDN_MAX_AGE, '3600');
  assert.equal(pick('stage', 'west').CAAS_CDN_MAX_AGE, '86400');
  assert.equal(pick('prod', 'west').CAAS_REMOTE_PEERS, 'https://east.example');
  assert.equal(pick('prod', 'east').CAAS_REMOTE_PEERS, undefined);
  assert.equal(pick('sit', 'east').ONLY_HERE, undefined);
  assert.equal(pick('stage', 'east').ONLY_HERE, '1');
  assert.equal(pick('sit', 'east').CAAS_BROWSER_MAX_AGE, '60');
});

test('local: ./global.properties; environment variables win; env/zone may come from the file', () => {
  const d = dirWith({ 'global.properties': `CAAS_ENV=sit\nCAAS_ZONE=west\n${FILE}\n` });
  const fromFile = loadEnvironment({}, d);
  assert.equal(fromFile.source, join(d, 'global.properties'));
  assert.equal(fromFile.env.CAAS_ENV, 'sit');
  assert.equal(fromFile.env.CAAS_CDN_MAX_AGE, '300');

  const overridden = loadEnvironment({ CAAS_ENV: 'prod', CAAS_ZONE: 'west', CAAS_CDN_MAX_AGE: '5' }, d);
  assert.equal(overridden.env.CAAS_CDN_MAX_AGE, '5');
  assert.equal(overridden.env.CAAS_REMOTE_PEERS, 'https://east.example');
});

test('PROPS_PATH as a file path: must exist; no file at all is fine', () => {
  const empty = dirWith({});
  assert.equal(loadEnvironment({ X: '1' }, empty).source, undefined);
  assert.throws(() => loadEnvironment({ PROPS_PATH: 'nope.properties' }, empty), /does not exist/);
  const custom = dirWith({ 'mnt/props/global.properties': 'caas.cdn.max.age=42' });
  assert.equal(loadEnvironment({ PROPS_PATH: 'mnt/props/global.properties' }, custom).env.CAAS_CDN_MAX_AGE, '42');
});

test('PROPS_PATH as a URL: fetched at startup with retries and auth header, then used by loadEnvironment', async () => {
  let calls = 0;
  let auth: string | undefined;
  const server = createServer((req, res) => {
    calls++;
    auth = req.headers.authorization;
    if (calls < 3) return void res.writeHead(503).end();
    res.writeHead(200, { 'content-type': 'text/plain' }).end('[sit]\ncaas.cdn.max.age=77\nnew.relic.app.name=caas-sit\n');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  try {
    const base = { PROPS_PATH: `http://user:pw@127.0.0.1:${port}/props/global.properties?token=secret`, CAAS_ENV: 'sit' };
    assert.throws(() => loadEnvironment(base), /preloadProperties\(\) must run/);
    const source = await preloadProperties(base);
    assert.equal(source, `http://127.0.0.1:${port}/props/global.properties`, 'credentials and query are not kept');
    assert.equal(calls, 3);
    assert.equal(auth, `Basic ${Buffer.from('user:pw').toString('base64')}`);
    const env = loadEnvironment(base).env;
    assert.equal(env.CAAS_CDN_MAX_AGE, '77');
    assert.equal(env.NEW_RELIC_APP_NAME, 'caas-sit');
  } finally {
    server.close();
  }
});

test('PROPS_PATH URL that never answers fails with a clear error', async () => {
  await assert.rejects(
    preloadProperties({ PROPS_PATH: 'http://127.0.0.1:9/global.properties', PROPS_FETCH_TIMEOUT_MS: '600' }),
    /could not load properties from http:\/\/127\.0\.0\.1:9\/global\.properties after \d+ attempt/,
  );
  assert.equal(redactUrl('https://a:b@h.example/x?y=1'), 'https://h.example/x');
});

test('${NAME} references resolve from the environment and the file', () => {
  const d = dirWith({
    'global.properties': 'base.url=https://sync.example\ncaas.remote.peers=${base.url}/east,${OTHER_URL}\ncaas.sync.secret=${VAULT_SECRET}\n',
  });
  const r = loadEnvironment({ OTHER_URL: 'https://other.example', VAULT_SECRET: 'from-vault-0123456789' }, d);
  assert.equal(r.env.CAAS_REMOTE_PEERS, 'https://sync.example/east,https://other.example');
  assert.equal(r.env.CAAS_SYNC_SECRET, 'from-vault-0123456789');
  assert.throws(() => loadEnvironment({}, d), /references \$\{OTHER_URL\}/);

  const loop = dirWith({ 'global.properties': 'a=${b}\nb=${a}\n' });
  assert.throws(() => loadEnvironment({}, loop), /circular/);
});

test('extra environment names can be declared', () => {
  const d = dirWith({ 'global.properties': 'CAAS_KNOWN_ENVS=qa2\nqa2.caas.cdn.max.age=11\ncaas.cdn.max.age=99\n' });
  assert.equal(loadEnvironment({ CAAS_ENV: 'qa2' }, d).env.CAAS_CDN_MAX_AGE, '11');
});

test('loadConfig reads ./global.properties from the working directory', () => {
  const d = dirWith({ 'global.properties': '[sit]\ncaas.cdn.max.age=123\ncaas.html.policy=reject\n' });
  const cwd = process.cwd();
  const saved = { ...process.env };
  try {
    process.chdir(d);
    process.env.CAAS_ENV = 'sit';
    for (const k of ['PROPS_PATH', 'CAAS_CDN_MAX_AGE', 'CAAS_HTML_POLICY']) delete process.env[k];
    const cfg = loadConfig();
    assert.equal(cfg.cdnMaxAge, 123);
    assert.equal(cfg.htmlPolicy, 'reject');
    assert.equal(cfg.propertiesSource, join(d, 'global.properties'));
  } finally {
    process.chdir(cwd);
    process.env = saved;
  }
});
