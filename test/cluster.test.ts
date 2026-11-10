/**
 * End-to-end test of the replication design using real processes:
 * an "east" cluster of up to four pods, a "west" cluster of two pods, and a
 * fake Akamai purge endpoint. Each pod has its own embedded database.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

const TOKEN = 'test-admin-token-0123456789';
const SECRET = 'test-sync-secret-0123456789';
const BASE = 43100 + (process.pid % 400) * 10;
const PORTS = { a: BASE, b: BASE + 1, c: BASE + 2, d: BASE + 3, w1: BASE + 4, w2: BASE + 5, akamai: BASE + 6 };
const url = (port: number) => `http://127.0.0.1:${port}`;
const EAST = [PORTS.a, PORTS.b, PORTS.c, PORTS.d].map(url).join(',');
const WEST = [PORTS.w1, PORTS.w2].map(url).join(',');
const SYNC_INTERVAL = 1000;

const tmp = mkdtempSync(join(tmpdir(), 'caas-test-'));
const pods = new Map<string, ChildProcess>();
const purges: Array<{ path: string; auth: string; objects: string[] }> = [];
let akamai: Server;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const admin = { authorization: `Bearer ${TOKEN}` };

async function startPod(name: keyof typeof PORTS, zone: 'east' | 'west'): Promise<void> {
  const child = spawn('tsx', ['test/dev-server.ts'], {
    env: {
      ...process.env,
      NODE_OPTIONS: '--disable-warning=ExperimentalWarning',
      PORT: String(PORTS[name]),
      POD_NAME: `caas-${zone}-${name}`,
      CAAS_ENV: 'sit',
      CAAS_ZONE: zone,
      CAAS_DATA_DIR: join(tmp, name),
      CAAS_SEED_DIR: 'content-seed',
      CAAS_ADMIN_TOKENS: `tester:${TOKEN}`,
      CAAS_SYNC_SECRET: SECRET,
      CAAS_PEERS: zone === 'east' ? EAST : WEST,
      // Each zone knows one endpoint of the other zone (in EKS: the other zone's internal load balancer).
      CAAS_REMOTE_PEERS: zone === 'east' ? url(PORTS.w1) : url(PORTS.a),
      CAAS_SYNC_INTERVAL_MS: String(SYNC_INTERVAL),
      CAAS_BOOTSTRAP_TIMEOUT_MS: '4000',
      CAAS_PUSH_TIMEOUT_MS: '1500',
      AKAMAI_BASE_URL: url(PORTS.akamai),
      AKAMAI_CLIENT_TOKEN: 'ct',
      AKAMAI_CLIENT_SECRET: 'cs',
      AKAMAI_ACCESS_TOKEN: 'at',
    },
    stdio: ['ignore', 'ignore', 'inherit'],
    // tsx runs the server in a child of its own, so the pod is stopped by killing the whole process group.
    detached: true,
  });
  pods.set(name, child);
  for (let i = 0; i < 150; i++) {
    const ok = await fetch(`${url(PORTS[name])}/api/health/ready`).then((r) => r.ok, () => false);
    if (ok) return;
    await sleep(100);
  }
  throw new Error(`pod ${name} did not become ready`);
}

async function stopPod(name: string): Promise<void> {
  const child = pods.get(name);
  if (!child) return;
  pods.delete(name);
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    process.kill(-child.pid!, 'SIGKILL');
  });
  // Wait until the port is really closed.
  for (let i = 0; i < 50; i++) {
    const up = await fetch(`${url(PORTS[name as keyof typeof PORTS])}/api/health/live`).then(() => true, () => false);
    if (!up) return;
    await sleep(50);
  }
  throw new Error(`pod ${name} did not stop`);
}

const read = (pod: keyof typeof PORTS, path: string, headers: Record<string, string> = {}) =>
  fetch(`${url(PORTS[pod])}/api/caas/${path}`, { headers });
const write = (pod: keyof typeof PORTS, path: string, content: unknown, headers: Record<string, string> = {}) =>
  fetch(`${url(PORTS[pod])}/api/caas-admin/content/${path}`, {
    method: 'PUT',
    headers: { ...admin, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(content),
  });

async function eventually(check: () => Promise<void>, timeoutMs = SYNC_INTERVAL * 6): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await check();
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await sleep(100);
    }
  }
}

before(async () => {
  akamai = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      purges.push({ path: req.url ?? '', auth: req.headers.authorization ?? '', objects: JSON.parse(body).objects });
      res.writeHead(201, { 'content-type': 'application/json' }).end('{"httpStatus":201}');
    });
  }).listen(PORTS.akamai, '127.0.0.1');
  await Promise.all([startPod('a', 'east'), startPod('b', 'east'), startPod('c', 'east')]);
});

after(async () => {
  await Promise.all([...pods.keys()].map(stopPod));
  akamai.close();
  rmSync(tmp, { recursive: true, force: true });
});

test('seed content is served by every pod with CDN cache headers', async () => {
  for (const pod of ['a', 'b', 'c'] as const) {
    const res = await read(pod, 'offers/home/hero.json');
    assert.equal(res.status, 200);
    assert.equal((await res.json()).title, 'Welcome');
    assert.match(res.headers.get('cache-control') ?? '', /public, max-age=60, s-maxage=86400/);
    assert.match(res.headers.get('edge-cache-tag') ?? '', /^caas-sit,caas-sit-offers,caas-sit-offers-[0-9a-f]{16}$/);
    assert.equal(res.headers.get('x-caas-zone'), 'east');
  }
  // The ".json" suffix is optional.
  assert.equal((await read('a', 'offers/home/hero')).status, 200);
});

test('admin and sync endpoints reject unauthenticated callers', async () => {
  const noToken = await fetch(`${url(PORTS.a)}/api/caas-admin/content/offers/x`, { method: 'PUT', body: '{}' });
  assert.equal(noToken.status, 401);
  const badToken = await fetch(`${url(PORTS.a)}/api/caas-admin/status`, { headers: { authorization: 'Bearer wrong' } });
  assert.equal(badToken.status, 401);
  assert.equal((await fetch(`${url(PORTS.a)}/api/internal/sync/digest`)).status, 401);
  const push = await fetch(`${url(PORTS.a)}/api/internal/sync/push`, { method: 'POST', body: '{"entries":[]}' });
  assert.equal(push.status, 401);
});

test('an update on one pod is on every pod immediately, and the CDN is purged', async () => {
  purges.length = 0;
  const res = await write('a', 'offers/home/hero', { title: 'Black Friday' });
  assert.equal(res.status, 200);
  const report = await res.json();
  assert.equal(report.entry.updatedBy, 'tester');
  assert.deepEqual(
    report.replication.filter((r: { scope: string }) => r.scope === 'local').map((r: { ok: boolean }) => r.ok),
    [true, true, false], // b and c acknowledged; d is not running yet
  );
  assert.equal(report.cdn.status, 'ok');

  // No waiting: the write only returned after b and c acknowledged it.
  for (const pod of ['a', 'b', 'c'] as const) {
    assert.equal((await (await read(pod, 'offers/home/hero')).json()).title, 'Black Friday');
  }

  assert.equal(purges.length, 1);
  assert.equal(purges[0].path, '/ccu/v3/invalidate/tag/production');
  assert.match(purges[0].auth, /^EG1-HMAC-SHA256 client_token=ct;access_token=at;timestamp=\d{8}T\d\d:\d\d:\d\d\+0000;nonce=[^;]+;signature=.+$/);
  assert.match(purges[0].objects[0], /^caas-sit-offers-[0-9a-f]{16}$/);
});

test('conditional requests return 304 and the in-memory cache is dropped on update', async () => {
  const first = await read('b', 'offers/home/hero');
  const etag = first.headers.get('etag') ?? '';
  assert.equal((await read('b', 'offers/home/hero')).headers.get('x-caas-cache'), 'HIT');
  assert.equal((await read('b', 'offers/home/hero', { 'if-none-match': etag })).status, 304);

  await write('a', 'offers/home/hero', { title: 'Cyber Monday' });
  const afterUpdate = await read('b', 'offers/home/hero', { 'if-none-match': etag });
  assert.equal(afterUpdate.status, 200);
  assert.equal(afterUpdate.headers.get('x-caas-cache'), 'MISS');
  assert.equal((await afterUpdate.json()).title, 'Cyber Monday');
});

test('If-Match prevents overwriting a newer edit', async () => {
  const stale = await write('a', 'offers/home/hero', { title: 'lost update' }, { 'if-match': '"stale"' });
  assert.equal(stale.status, 412);
  assert.equal((await (await read('a', 'offers/home/hero')).json()).title, 'Cyber Monday');
});

test('a pod that was down catches up from its peers before it is ready again', async () => {
  await stopPod('c');
  const res = await write('a', 'offers/checkout/banner', { text: 'Free shipping' });
  assert.equal(res.status, 201);
  const report = await res.json();
  assert.equal(report.replication.find((r: { url: string }) => r.url === url(PORTS.c)).ok, false);
  await startPod('c', 'east'); // same data directory as before, now out of date
  assert.equal((await (await read('c', 'offers/checkout/banner')).json()).text, 'Free shipping');
});

test('deleted seed content stays deleted, including on a pod that scales up later', async () => {
  const del = await fetch(`${url(PORTS.b)}/api/caas-admin/content/navigation/main`, { method: 'DELETE', headers: admin });
  assert.equal(del.status, 200);
  for (const pod of ['a', 'b', 'c'] as const) assert.equal((await read(pod, 'navigation/main')).status, 404);

  await startPod('d', 'east'); // brand-new pod, empty database, loads the seed first
  assert.equal((await read('d', 'navigation/main')).status, 404);
  assert.equal((await (await read('d', 'offers/home/hero')).json()).title, 'Cyber Monday');
  assert.equal((await (await read('d', 'offers/checkout/banner')).json()).text, 'Free shipping');
});

test('conflicting writes on two pods converge to one value everywhere', async () => {
  await Promise.all([write('a', 'offers/race', { winner: 'a' }), write('b', 'offers/race', { winner: 'b' })]);
  await eventually(async () => {
    const values = await Promise.all((['a', 'b', 'c', 'd'] as const).map(async (p) => (await (await read(p, 'offers/race')).json()).winner));
    assert.equal(new Set(values).size, 1, `pods disagree: ${values.join(',')}`);
  });
});

test('updates cross zones: east -> west and west -> east', async () => {
  await Promise.all([startPod('w1', 'west'), startPod('w2', 'west')]);
  // West bootstrapped from east, so it already has runtime edits rather than seed values.
  assert.equal((await (await read('w2', 'offers/home/hero')).json()).title, 'Cyber Monday');
  assert.equal((await read('w2', 'offers/home/hero')).headers.get('x-caas-zone'), 'west');

  // East pod a pushes to w1, which relays to w2 before acknowledging.
  await write('a', 'offers/home/hero', { title: 'From east' });
  assert.equal((await (await read('w2', 'offers/home/hero')).json()).title, 'From east');

  // West pod w2 pushes to east pod a, which relays to b, c and d.
  await write('w2', 'offers/home/hero', { title: 'From west' });
  for (const pod of ['a', 'b', 'c', 'd', 'w1'] as const) {
    assert.equal((await (await read(pod, 'offers/home/hero')).json()).title, 'From west');
  }
});

test('all pods end up with an identical database', async () => {
  await eventually(async () => {
    const hashes = await Promise.all(
      (['a', 'b', 'c', 'd', 'w1', 'w2'] as const).map(async (p) => (await (await fetch(`${url(PORTS[p])}/api/caas-admin/status`, { headers: admin })).json()).stateHash),
    );
    assert.equal(new Set(hashes).size, 1);
  });
});

test('manual purge clears pods in both zones and purges the service tag', async () => {
  purges.length = 0;
  await read('w2', 'offers/home/hero');
  const res = await fetch(`${url(PORTS.a)}/api/caas-admin/purge`, {
    method: 'POST',
    headers: { ...admin, 'content-type': 'application/json' },
    body: JSON.stringify({ service: 'offers' }),
  });
  const report = await res.json();
  assert.equal(res.status, 200);
  assert.ok(report.pods.every((p: { ok: boolean }) => p.ok));
  assert.ok(purges.some((p) => p.objects.join() === 'caas-sit-offers'));
  assert.equal((await read('w2', 'offers/home/hero')).headers.get('x-caas-cache'), 'MISS');
});

test('history and rollback', async () => {
  const base = `${url(PORTS.a)}/api/caas-admin/content/offers/home/hero`;
  const { versions } = await (await fetch(`${base}?history=1`, { headers: admin })).json();
  assert.ok(versions.length >= 3);
  const target = versions.find((v: { updatedBy: string }) => v.updatedBy === 'seed');
  const res = await fetch(base, { method: 'POST', headers: admin, body: JSON.stringify({ rollbackTo: target.hlc }) });
  assert.equal(res.status, 200);
  for (const pod of ['a', 'c', 'w2'] as const) {
    assert.equal((await (await read(pod, 'offers/home/hero')).json()).title, 'Welcome');
  }
});

test('bulk import and export', async () => {
  const entries = Array.from({ length: 60 }, (_, i) => ({ service: 'catalog', path: `items/item-${i}`, content: { id: i } }));
  purges.length = 0;
  const imp = await fetch(`${url(PORTS.b)}/api/caas-admin/transfer`, {
    method: 'POST',
    headers: { ...admin, 'content-type': 'application/json' },
    body: JSON.stringify({ entries }),
  });
  assert.equal((await imp.json()).imported, 60);
  assert.ok(purges.some((p) => p.objects.join() === 'caas-sit-catalog'));
  assert.equal((await (await read('w1', 'catalog/items/item-59')).json()).id, 59);

  const bad = await fetch(`${url(PORTS.b)}/api/caas-admin/transfer`, {
    method: 'POST',
    headers: admin,
    body: JSON.stringify({ entries: [{ service: 'catalog', path: '../etc/passwd', content: {} }] }),
  });
  assert.equal(bad.status, 400);

  const exp = await (await fetch(`${url(PORTS.d)}/api/caas-admin/transfer`, { headers: admin })).json();
  assert.equal(exp.entries.filter((e: { service: string }) => e.service === 'catalog').length, 60);
});

test('duplicate keys in an upload are refused unless the caller says which value to keep', async () => {
  const body = '{"title":"first","cta":{"label":"a","label":"b"},"title":"second"}';
  const put = (q = '') =>
    fetch(`${url(PORTS.a)}/api/caas-admin/content/offers/dupes${q}`, { method: 'PUT', headers: { ...admin, 'content-type': 'application/json' }, body });
  const refused = await put();
  assert.equal(refused.status, 409);
  const details = await refused.json();
  assert.deepEqual(details.duplicates, [
    { pointer: '/cta/label', values: ['a', 'b'] },
    { pointer: '/title', values: ['first', 'second'] },
  ]);
  assert.equal((await read('a', 'offers/dupes')).status, 404);

  const first = await put('?duplicates=first');
  assert.equal(first.status, 201);
  assert.equal((await first.json()).duplicatesResolved.length, 2);
  assert.deepEqual(await (await read('b', 'offers/dupes')).json(), { title: 'first', cta: { label: 'a' } });
});

test('XSS payloads are sanitized before they are stored and served', async () => {
  const res = await write('a', 'offers/xss', {
    html: '<p>ok</p><img src=x onerror=alert(1)><script>alert(2)</script>',
    link: 'javascript:alert(3)',
    note: '</script><b>bold</b>',
  });
  assert.equal(res.status, 201);
  const report = await res.json();
  // '/note' only loses a stray </script> with no opening tag: normalised, not reported as a removal.
  assert.deepEqual(report.sanitized.map((s: { pointer: string }) => s.pointer).sort(), ['/html', '/link']);

  const served = await read('c', 'offers/xss');
  const text = await served.text();
  assert.doesNotMatch(text, /[<>]/, 'markup characters are \\u-escaped in the JSON text');
  const v = JSON.parse(text);
  assert.equal(v.html, '<p>ok</p><img src="x" />');
  assert.equal(v.link, '');
  assert.equal(v.note, '<b>bold</b>');
  assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
  assert.match(served.headers.get('content-security-policy') ?? '', /default-src 'none'/);

  const proto = await fetch(`${url(PORTS.a)}/api/caas-admin/content/offers/xss`, {
    method: 'PUT',
    headers: { ...admin, 'content-type': 'application/json' },
    body: '{"__proto__":{"isAdmin":true}}',
  });
  assert.equal(proto.status, 422);
});

test('validate and bulk dry run report what would change without writing', async () => {
  const v = await (
    await fetch(`${url(PORTS.a)}/api/caas-admin/validate`, {
      method: 'POST',
      headers: { ...admin, 'content-type': 'application/json' },
      body: JSON.stringify({ body: '<p style="color:red">ok</p><img src=x onerror=alert(1)>', note: 'a<br>b' }),
    })
  ).json();
  assert.equal(v.ok, true);
  assert.deepEqual(v.sanitized.map((x: { pointer: string }) => x.pointer), ['/body']);
  assert.match(v.sanitized[0].reason, /onerror/);
  assert.match(v.sanitized[0].before, /onerror/);
  assert.doesNotMatch(v.sanitized[0].after, /onerror/);

  const dry = await (
    await fetch(`${url(PORTS.a)}/api/caas-admin/transfer?dryRun=1`, {
      method: 'POST',
      headers: { ...admin, 'content-type': 'application/json' },
      body: JSON.stringify({ entries: [{ service: 'dry', path: 'a', content: { h: '<script>x</script>y' } }] }),
    })
  ).json();
  assert.equal(dry.wouldImport, 1);
  assert.equal(dry.sanitized[0].index, 0);
  assert.equal((await read('a', 'dry/a')).status, 404, 'dry run wrote nothing');
});

test('a new service route can be created once, and If-None-Match stops overwriting it', async () => {
  const create = () =>
    fetch(`${url(PORTS.b)}/api/caas-admin/content/promotions/summer/banner`, {
      method: 'PUT',
      headers: { ...admin, 'content-type': 'application/json', 'if-none-match': '*' },
      body: JSON.stringify({ headline: 'Summer', items: [{ sku: 1, tags: { hot: true } }] }),
    });
  assert.equal((await create()).status, 201);
  assert.equal((await create()).status, 412);
  const served = await (await read('w1', 'promotions/summer/banner.json')).json();
  assert.equal(served.items[0].tags.hot, true);
  const list = await (await fetch(`${url(PORTS.a)}/api/caas-admin/content`, { headers: admin })).json();
  assert.ok(list.services.includes('promotions'));
});

test('bulk import refuses the same route twice in one file and existing routes in create mode', async () => {
  const post = (entries: unknown, q = '') =>
    fetch(`${url(PORTS.a)}/api/caas-admin/transfer${q}`, { method: 'POST', headers: { ...admin, 'content-type': 'application/json' }, body: JSON.stringify({ entries }) });
  const twice = await post([
    { service: 'bulk', path: 'a', content: { v: 1 } },
    { service: 'bulk', path: 'a.json', content: { v: 2 } },
  ]);
  assert.equal(twice.status, 400);
  assert.match((await twice.json()).rejected[0].reason, /same service and path as entry 0/);

  assert.equal((await post([{ service: 'bulk', path: 'a', content: { v: 1 } }], '?mode=create')).status, 200);
  const again = await post([{ service: 'bulk', path: 'a', content: { v: 3 } }], '?mode=create');
  assert.equal(again.status, 400);
  assert.equal((await (await read('a', 'bulk/a')).json()).v, 1);
});
