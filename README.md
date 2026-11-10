# CaaS service

Content-as-a-Service on Next.js API routes. Each pod carries its own embedded
SQLite database inside the Node.js process; pods replicate content to each
other, so there is no external database tier. Content can be changed at
runtime through an admin API or console, and every change is replicated to all
pods in both zones and purged from the caches before the call returns.

```
Akamai CDN -> LB -> IG -> Apigee -> EKS service -> pod (Next.js + SQLite)
                                                    |  ^
                          push on write, pull to    v  |   same in the other zone,
                          repair, over HTTP + HMAC  other pods   linked by CAAS_REMOTE_PEERS
```

## How each requirement is met

| Requirement | How |
| --- | --- |
| Next.js API routes | Next.js 16 / React 19 App Router route handlers under `app/api`. The only page is the admin console. |
| Several CaaS services | One route, `/api/caas/{service}/{path}`. A service is just a namespace; adding one needs no code. |
| Database in the pod | `node:sqlite` (built into Node 22.5+), file on the pod's own volume. See `lib/caas/db.ts`. |
| Same route in SIT / CANARY / STAGE / PROD, east and west | One image and one set of routes. Only `CAAS_ENV`, `CAAS_ZONE` and peer addresses differ, set per overlay in `deploy/k8s/overlays`. |
| Cacheable | In-memory cache per pod, `ETag` / `304`, `Cache-Control` and `Edge-Control` for browser and Akamai TTLs. |
| Clear the cache on update | Pods drop their in-memory entry when they apply a change. The writing pod then calls Akamai Fast Purge by cache tag. Manual purge endpoint as well. |
| Update without redeploying | `PUT /api/caas-admin/content/...` or the console at `/caas-admin`. |
| Safe content | Duplicate keys are refused or resolved explicitly, string values are XSS-sanitized, all responses carry strict security headers. See [Admin console and content safety](#admin-console-and-content-safety). |
| Updates reach every pod when scaled | Push on write to all pods, periodic pull to repair, and a new pod syncs before it turns ready. |

## Run it locally

Requires Node 22.5 or newer (Node 26 LTS recommended).

```bash
yarn install
cp .env.example .env.local      # set CAAS_ADMIN_TOKENS and CAAS_SYNC_SECRET
yarn dev                        # http://localhost:3000, or the next free port

curl localhost:3000/api/caas/offers/home/hero.json

curl -X PUT localhost:3000/api/caas-admin/content/offers/home/hero \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"title":"Black Friday"}'
```

If port 3000 is taken (for example by another local Next.js app), `yarn dev`
uses the next free port and logs `admin console: http://localhost:<port>/caas-admin`.
The console always talks to the server it was loaded from and shows that
address on the connect screen. Use the token from this project's `.env.local`.

Open `http://localhost:3000/caas-admin` for the console.

`yarn test` starts six pods as separate processes (four "east", two "west") plus
a fake Akamai, and checks replication, catch-up after downtime, scale-up,
conflicts, cross-zone relay, purge, rollback and import.

## Configuration from global.properties

Every setting can come from environment variables or from `global.properties`,
which holds the values for every environment and zone in one file. The file is
not part of this repository or the image. See `global.properties.example`.

- **Where:** `PROPS_PATH`. An `http(s)://` URL (the properties service in EKS)
  is fetched once at startup, retried with backoff for `PROPS_FETCH_TIMEOUT_MS`
  (default 30 s); `PROPS_AUTH` is sent as the `Authorization` header, and
  `user:pass@` in the URL becomes Basic auth. A file path is read from disk.
  Without `PROPS_PATH`, `./global.properties` is used if it exists (local
  development). If `PROPS_PATH` is set but cannot be loaded, the pod exits at
  startup so Kubernetes restarts it and the failure is visible.
- **Format:** read with [`properties-reader`](https://www.npmjs.com/package/properties-reader):
  `key=value`, `#` comments, `[section]` headers that prefix the keys below
  them. Values are used as raw strings.
- **Keys:** the env-var name (`CAAS_CDN_MAX_AGE`) or dotted
  (`caas.cdn.max-age`); both mean the same setting.
- **One file per environment:** each environment (alpha, beta1, beta2,
  canary, stage, prod) is served its own file, so plain keys are that
  environment's values. What differs between zones goes under `[east]` /
  `[west]` (typically `caas.remote.peers`). `CAAS_ENV` / `CAAS_ZONE` come from
  the environment, else from the file (`caas.env=beta1`). A file shared by
  several environments can also use `[sit]`, `[prod.west]` or a key prefix
  (`sit.caas.cdn.max.age=300`); keys for other environments or zones are
  ignored.
- **Precedence:** environment variable > `[env.zone]` > `[zone]` > `[env]` > top of file.
  A value in the pod spec, the `caas-config` ConfigMap or a Secret always wins,
  so remove literals from `caas-config` that you manage in the file.
- **References:** `${NAME}` is replaced from the environment or the file, e.g.
  `new.relic.license.key=${NR_LICENSE_KEY}`. An unresolved reference stops startup.
- Read once at startup; restart the pods to pick up changes.
  `GET /api/caas-admin/status` shows where the properties came from (URL
  without credentials or query), never the values.

## Monitoring (New Relic)

The New Relic Node agent runs as the hybrid agent that Next.js 16 needs: it
starts from `instrumentation.ts` (after the properties are loaded, so its
settings can live in `global.properties`) and turns the OpenTelemetry spans
Next.js emits into transactions. Defaults are in `newrelic.js`; any
`NEW_RELIC_*` variable or `new.relic.*` property overrides them.

- **Enable:** set `NEW_RELIC_LICENSE_KEY` (best in the `caas-secrets` Secret).
  Without it, or with `NEW_RELIC_ENABLED=false`, the agent is not loaded.
  App name defaults to `caas-service-<env>`, with labels `env`, `zone`, `group`.
- **Load and latency:** one transaction per route (`/api/caas/[service]/[...path]`,
  admin routes), annotated with `caas.service`, `caas.cache` (HIT/MISS),
  `caas.found`, and on admin calls `caas.actor`, `caas.path`.
- **Errors:** unhandled route errors (via `onRequestError`, with the route),
  CDN purge failures, writes not acknowledged by every pod, anti-entropy
  failures. 4xx responses are not errors; they are counted as
  `Custom/CaaS/Responses/<status>`.
- **Events:** `CaasPublish` (per write: entries, services, pods ok/failed, CDN
  result, duration, actor) and `CaasHealth` (per pod every sync interval:
  ready, entries, peers in sync, cache size).
- **Metrics:** `Custom/CaaS/Reads/Found|NotFound`, `Admin/AuthFailed`,
  `Writes/SanitizedValues`, `Writes/DuplicateKeysResolved`,
  `Replication/PushFailed|PullFailed|RowsRepaired`, `Peers/OutOfSync`, `Entries`,
  `Errors/Unhandled`.
- **Logs:** every service log line is forwarded (`recordLogEvent`).
- **Not sent:** admin tokens, sync signatures and cookies are excluded from
  attributes; content bodies and full query strings are never recorded.
  `/api/health/*` probes are ignored.

Example NRQL: `SELECT average(durationMs), sum(podsFailed) FROM CaasPublish FACET appName TIMESERIES`,
`SELECT latest(peersInSync), latest(peers) FROM CaasHealth FACET node`.

## Troubleshooting: "the admin token was rejected"

The server logs where its tokens came from and a fingerprint of each (first
8 hex characters of its SHA-256; never the token itself):

```
admin API: tokens from environment (shell variable or .env / .env.local): me (48 chars, fingerprint 1a2b3c4d)
```

Every rejected request logs what arrived (at most once every 5 s):

```
admin token rejected: presented 51 chars, fingerprint 9f8e7d6c (header authorization); this server accepts me (48 chars, fingerprint 1a2b3c4d) from ...
```

To fingerprint the token you are pasting, run this and paste it at the prompt (it is not echoed or saved in shell history):

```bash
read -rs T && printf %s "$T" | shasum -a 256 | cut -c1-8
```

- **Length is 3 longer and fingerprints differ:** the token was pasted with its `me:` name.
- **Fingerprints differ, same length:** the server has a different token. Check
  the source named in the log. A `CAAS_ADMIN_TOKENS` variable set in the shell
  or system wins over `.env.local`. `.env.local` is git-ignored and differs per
  machine. The standalone `server.js` does not read `.env.local`, so tokens may
  come from `global.properties`. The value may also be the `change-me-…` placeholder.
- **Token contains `$`:** Next.js expands `$NAME` in `.env` files. Use hex
  tokens (`openssl rand -hex 24`) or escape it as `\$`.

## API

Public (route through Apigee):

| | |
| --- | --- |
| `GET /api/caas/{service}/{path}[.json]` | The content. `404` if missing. |

Admin (token required: `Authorization: Bearer <token>` or `x-caas-admin-token`):

| | |
| --- | --- |
| `GET /api/caas-admin/content?service=&prefix=` | List entries |
| `GET /api/caas-admin/content/{service}/{path}` | Read one entry; `?history=1`, `?version=<v>` |
| `PUT /api/caas-admin/content/{service}/{path}` | Create or replace. `If-Match: <etag>` avoids overwriting someone else's edit; `If-None-Match: *` only creates (new route). `?duplicates=error\|first\|last` (default `error`). |
| `DELETE /api/caas-admin/content/{service}/{path}` | Delete |
| `POST /api/caas-admin/content/{service}/{path}` | `{"rollbackTo":"<version>"}` |
| `POST /api/caas-admin/purge` | `{}`, `{"service"}` or `{"service","path"}` |
| `GET /api/caas-admin/status` | This pod's peers and whether they are in sync |
| `GET`, `POST /api/caas-admin/transfer` | Bulk export / import (AEM migration, backups). `?mode=upsert\|create`, `?duplicates=…` |
| `GET /caas-admin` | Console |

Every write response reports which pods acknowledged the change and the result
of the CDN purge.

Internal (never expose): `/api/internal/sync/*` for pod-to-pod replication,
`/api/health/live` and `/api/health/ready` for probes.

## Admin console and content safety

`/caas-admin` is a React page (client components, no server data). Paste an
admin token to connect; it is kept in that tab's memory only.

- **Browse and edit:** services and routes on the left; the *Fields* tab edits
  nested content (rename keys, change types, add/remove fields and array items
  at any depth); the *JSON* tab edits the raw document.
- **New service / route:** *+ New* takes a service and a path. A service exists
  once it has a route. Saving uses `If-None-Match: *`, so an existing route is
  never overwritten by a "create".
- **Upload JSON:** one document (merge into the open entry or create a new
  route) or a bulk file in the export shape. Two kinds of duplicates are shown
  rather than resolved silently:
  - the same key twice in one object (`{"a":1,"a":2}`): every value is listed
    and you pick which one to keep (default last);
  - a key already in the entry with a different value: every conflict is
    listed with both values; choose per key, or merge with "file wins" /
    "keep current", or replace entirely.
  - bulk files: the same route twice in the file is flagged (keep first or
    last), and existing routes can be overwritten or skipped.
  Uploads load into the editor first; nothing is published until you save.
- **History** shows the versions kept on the pod; restore republishes one.

XSS and injection defences:

| Layer | Measure |
| --- | --- |
| Input | Strict parser (`lib/caas/json-tools.ts`) with depth limit; duplicate keys refused by default (409 lists them). |
| Input | `lib/caas/sanitize.ts` on every admin write, import and rollback: `__proto__` / `constructor` / `prototype` keys and keys with control chars or `<>` are refused (422); strings with markup go through an allowlist HTML sanitizer (no script, event handlers, style, iframes, svg; links only http/https/mailto/tel); `javascript:`, `vbscript:`, `file:` and non-image `data:` URLs are blanked. `CAAS_HTML_POLICY=reject` refuses instead of cleaning. The response lists every value that was changed. |
| Output | JSON responses escape `<`, `>`, `&`, U+2028/2029 as `\uXXXX` (same value, inert if inlined in HTML), and send `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'`, `X-Frame-Options: DENY`. |
| Console | Per-request nonce CSP with `strict-dynamic` from `proxy.ts` (no inline or third-party script, no framing, `connect-src 'self'`); all content rendered as React text, never HTML (`react/no-danger` and `innerHTML` are lint errors); token sent as a header with `credentials: 'omit'`, so there is no cookie to ride in a CSRF. |
| Everywhere | `next.config.mjs` adds HSTS, `Referrer-Policy: no-referrer`, COOP and a restrictive `Permissions-Policy`. |

## How replication works

- Every row has a version from a hybrid logical clock. A row is replaced only
  by a higher version, so all pods end at the same value whatever order
  updates arrive in. Two simultaneous edits of the same entry: the later one wins.
- **Write:** the pod commits locally, pushes the row to every pod in its
  cluster and to the other zone's endpoint, waits for acknowledgements (bounded
  by `CAAS_PUSH_TIMEOUT_MS`), and only then purges Akamai. The pod that
  receives the push in the other zone relays it to its own cluster before
  acknowledging.
- **Repair:** every `CAAS_SYNC_INTERVAL_MS` each pod compares a state hash with
  each peer and pulls what it lacks. If a pod missed a push, the writing pod
  purges the CDN a second time after the repair window.
- **Start / scale-up:** a pod loads the seed, pulls from its peers, and only
  then answers `/api/health/ready` with 200.
- **Deletes** are kept as tombstones so an old pod or the seed cannot bring
  content back.
- **Seed:** `content-seed/{service}/{path}.json` is baked into the image for
  first boot. Seed rows have the lowest possible version, so anything edited
  at runtime always wins. Raise `CAAS_SEED_VERSION` when a release ships newer
  seed content.
- **Canary** uses `CAAS_REPLICATION_GROUP=prod`, so it serves prod content. Set
  it to `canary` in the two canary overlays if canary should have its own.

## Deploying to EKS

```bash
docker build -t <registry>/caas-service:1.0.0 .
kubectl apply -k deploy/k8s/overlays/prod-east     # against the east cluster
kubectl apply -k deploy/k8s/overlays/prod-west     # against the west cluster
```

Before the first deploy:

1. Create the Secret `caas-secrets` in each namespace (keys are listed in
   `deploy/k8s/base/kustomization.yaml`). `CAAS_SYNC_SECRET` must be identical
   in east and west.
2. Replace the image registry and the `CAAS_REMOTE_PEERS` placeholder in each
   overlay. That URL is an internal-only endpoint through which a pod in one
   zone reaches the service in the other zone.
3. Apigee: expose `/api/caas/**` publicly. Keep `/api/caas-admin/**` and
   `/caas-admin` on an internal or restricted proxy. Do not route
   `/api/internal/**` at all.
4. Akamai: enable cache tags (`Edge-Cache-Tag`) and honouring of origin
   `Edge-Control` / `Cache-Control` on the property, and create an API client
   with purge permission.
5. Apigee and IG must not cache these responses themselves (no ResponseCache
   policy), otherwise they keep serving old content after a purge.

## Limits to know about

- **Consistency is eventual.** In the normal case every pod has the change
  before the write returns. If a pod is unreachable, it serves the old value
  until the next repair round (15 s by default).
- **Durability comes from copies, not from one disk.** Each pod keeps its
  database on its own volume, and any surviving pod in either zone restores
  the others. Content edited at runtime is lost only if every volume in both
  zones is lost at once. Schedule `GET /api/caas-admin/transfer` as a backup
  if that risk matters.
- **History is per pod** and best-effort (last 20 versions by default); a
  freshly created pod has no history for older edits.
- **One server process per pod.** Do not run Node cluster mode or several
  Next.js workers against the same data directory.
- `node:sqlite` prints an experimental warning on older Node versions; the image
  silences it.
- TypeScript: `tsc` is TypeScript 7 (`@typescript/native`); the `typescript`
  package is the TS 6 API, because typescript-eslint does not support TS 7 yet. Swapping to `better-sqlite3` only touches `lib/caas/db.ts`.

## Layout

```
app/api/caas/[service]/[...path]/route.ts   public content route
app/api/caas-admin/**                       admin API
app/api/internal/sync/[action]/route.ts     pod-to-pod replication
app/api/health/[probe]/route.ts             probes
app/caas-admin/                             console (React page, field editor, upload)
proxy.ts                                    nonce CSP for the console
instrumentation.ts                          loads properties, starts New Relic, opens the DB and starts replication
newrelic.js                                 New Relic agent defaults (no secrets)
lib/caas/                                   store, clock, replication, cache, CDN purge, auth
content-seed/                               first-boot content
deploy/k8s/                                 kustomize base and one overlay per env and zone
test/                                       multi-pod test and its minimal test server
```
