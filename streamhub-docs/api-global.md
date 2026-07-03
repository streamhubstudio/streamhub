# StreamHub — Global API

Server-wide endpoints (not scoped to a single app). All paths are under the global prefix
`/api/v1`. Per-app endpoints are documented in [api-app.md](./api-app.md).

- Production base URL: `https://streamhub.example.com/api/v1`
- Core bind (internal): `http://127.0.0.1:3020/api/v1`

| Method | Path | Auth | Summary |
|--------|------|------|---------|
| GET | `/health` | Public | Liveness probe |
| GET | `/stats` | Bearer | Server stats (CPU/mem/disk, counts, LiveKit status) |
| GET | `/auth/config` | Public | Auth capabilities: `{ allowSignup }` (STREAMHUB_ALLOW_SIGNUP) |
| POST | `/auth/signup` | Public (gated) | Create user + team; `403 signup_disabled` when signup is off |
| POST | `/auth/login` | Public | Email/password (+ TOTP `code` when 2FA is on) → session JWT |
| POST | `/auth/magic-link` | Public | Email a sign-in link; 60s resend cooldown → 429 + `retryAfterSeconds` |
| POST | `/auth/magic/verify` | Public | One-time token (+ TOTP `code` when 2FA is on) → session JWT |
| GET | `/account` | Bearer (human JWT) | My profile + tenant + security flags |
| PATCH | `/account` | Bearer (human JWT) | Update my name/email |
| POST | `/account/password` | Bearer (human JWT) | Change my password |
| POST | `/account/2fa/setup` | Bearer (human JWT) | Start TOTP enrolment (secret + otpauth URI + QR data URI) |
| POST | `/account/2fa/enable` | Bearer (human JWT) | Activate 2FA with a live code |
| POST | `/account/2fa/disable` | Bearer (human JWT) | Disable 2FA with a live code |
| GET | `/tenant/invites` | Bearer (owner) | Pending email invitations of MY tenant |
| POST | `/tenant/invites` | Bearer (owner) | Invite by email (pending user + 72h single-use link) |
| DELETE | `/tenant/invites/{userId}` | Bearer (owner) | Revoke a pending invitation |
| GET | `/apps` | Bearer | List apps |
| POST | `/apps` | Bearer | Create an app (scaffolds dirs/config/db/samples) |
| GET | `/apps/{name}` | Bearer | Get one app |
| PATCH | `/apps/{name}` | Bearer | Edit an app's config |
| DELETE | `/apps/{name}` | Bearer | Delete an app (optionally purge VODs) |
| GET | `/tokens` | Bearer | List API tokens |
| POST | `/tokens` | Bearer | Create an API token (plaintext returned once) |
| DELETE | `/tokens/{id}` | Bearer | Revoke an API token |
| GET | `/logs` | Bearer | Query server logs |
| GET | `/system/settings` | Bearer (global) | Read-only effective server config (secrets redacted) + change guidance |
| POST | `/cluster/join` | `X-Cluster-Token` | Register an edge node (installer); returns bootstrap config |
| POST | `/cluster/heartbeat` | `X-Cluster-Token` | Node liveness ping (optional `stats`) |
| GET | `/cluster/info` | Bearer (global) | Cluster overview + copy-paste join one-liner |
| GET | `/cluster/nodes` | Bearer (global) | List registered nodes (parsed `stats` + derived `stale`) |
| PATCH | `/cluster/nodes/{id}` | Bearer (global) | Update a node's name/region/status |
| DELETE | `/cluster/nodes/{id}` | Bearer (global) | Remove a node from the registry |

---

## Authentication

Every endpoint requires `Authorization: Bearer <token>` **except**: `/health`, the
OpenAPI docs (`/docs`, `/openapi.json`) and public player/asset routes (`/play`,
`/embed`, `/assets`, `/samples`).

**How validation works** (global `StreamHubAuthGuard` + `AuthService`):

1. The `Bearer` token is extracted from the `Authorization` header.
2. It is SHA-256 hashed and matched against `api_tokens.token_hash`. Revoked tokens are
   rejected.
3. If the token has an `allowed_ips` whitelist, the client IP must match (exact IPv4/IPv6
   or IPv4 CIDR). The client IP is taken from the request (honouring proxy headers).
4. On success the token's `last_used_at` is updated and the request carries an auth
   context `{ tokenId, scope, appId }`.

**Token scope**

- `global` — full access to global + any app endpoints. Used by the UI server.
- `app` — bound to a single `app_id`; intended for per-app integrations.

Besides `sk_` API tokens the guard accepts the HS256 **session JWTs** minted by
`/auth/login`, `/auth/signup` and `/auth/magic/verify`. Account self-service
(`/account*`), team invitations (`/tenant/invites*`), the signup gate
(`STREAMHUB_ALLOW_SIGNUP`), 2FA (TOTP) and the magic-link resend cooldown are
documented in [features/auth.md](features/auth.md).

**Error responses**

| Status | When |
|--------|------|
| 401 Unauthorized | Missing/invalid/revoked token, or client IP not in the token whitelist |
| 403 Forbidden | (where applicable) scope not permitted for the resource |
| 404 Not Found | Resource (app/token) does not exist |
| 400 Bad Request | Validation error on body/query |

Error body (NestJS default):

```json
{ "statusCode": 401, "message": "Invalid or revoked API token", "error": "Unauthorized" }
```

---

## GET /health

Liveness probe. **Public — no auth.** Used by load balancers and the UI.

**Response 200**

```json
{
  "status": "ok",
  "up": true,
  "version": "0.1.0",
  "ts": "2026-06-30T12:00:00.000Z",
  "uptimeSeconds": 1234
}
```

**curl**

```bash
curl -s https://streamhub.example.com/api/v1/health
```

---

## GET /stats

Authenticated server stats: CPU/mem/disk, uptime, version, LiveKit reachability, counts
of apps/rooms/active streams, and egress/ingress status.

**Auth**: Bearer.

**Response 200**

```json
{
  "ts": "2026-06-30T12:00:00.000Z",
  "uptimeSeconds": 1234,
  "version": "0.1.0",
  "cpu": { "loadAvg": [0.5, 0.4, 0.3], "cores": 8 },
  "memory": { "totalBytes": 16777216000, "freeBytes": 8388608000, "usedBytes": 8388608000 },
  "disk": { "totalBytes": 500000000000, "freeBytes": 250000000000, "usedBytes": 250000000000 },
  "livekitReachable": true,
  "counts": { "apps": 3, "rooms": 2, "activeStreams": 4 },
  "egress": { "reachable": true, "active": 1, "total": 2 },
  "ingress": { "reachable": true, "active": 1, "total": 2 }
}
```

`disk` may be `null` if disk stats cannot be read.

**curl**

```bash
curl -s https://streamhub.example.com/api/v1/stats \
  -H "Authorization: Bearer $STREAMHUB_TOKEN"
```

---

## GET /apps

List all apps (tenants).

**Auth**: Bearer.

**Response 200** — array of `AppRecord`:

```json
[
  {
    "id": 1,
    "name": "live",
    "displayName": "Live",
    "livekitRoomPrefix": "live",
    "createdAt": "2026-06-30 12:00:00",
    "updatedAt": "2026-06-30 12:00:00",
    "settingsJson": null
  }
]
```

**curl**

```bash
curl -s https://streamhub.example.com/api/v1/apps \
  -H "Authorization: Bearer $STREAMHUB_TOKEN"
```

---

## POST /apps

Create an app. Scaffolds `apps/<name>/` with `config.yaml`, a migrated `vods.db`,
`recordings/`, `snapshots/`, `samples/` and generates the sample pages.

**Auth**: Bearer.

**Body** (`CreateAppDto`)

| Field | Type | Required | Rules |
|-------|------|----------|-------|
| `name` | string | yes | Lowercase slug `^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$` (unique) |
| `displayName` | string | no | ≤ 100 chars |
| `roomPrefix` | string | no | ≤ 40 chars; defaults to `name` |

```json
{ "name": "demo", "displayName": "Demo", "roomPrefix": "demo" }
```

**Response 201** — the created `AppRecord` (see `GET /apps`).

**curl**

```bash
curl -s -X POST https://streamhub.example.com/api/v1/apps \
  -H "Authorization: Bearer $STREAMHUB_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"demo","displayName":"Demo","roomPrefix":"demo"}'
```

> Creating an app via the API is a first-class operation — this is the same path the UI
> uses. See [config-reference.md](./config-reference.md) for the generated `config.yaml`.

---

## GET /apps/{name}

Get one app by name.

**Auth**: Bearer. **Path**: `name` (slug, e.g. `live`).

**Response 200** — `AppRecord`. **404** if not found.

**curl**

```bash
curl -s https://streamhub.example.com/api/v1/apps/live \
  -H "Authorization: Bearer $STREAMHUB_TOKEN"
```

---

## PATCH /apps/{name}

Edit the app's `config.yaml`. Returns the merged, resolved `AppConfig`. Only the most
edited top-level fields are accepted here; the full transcoding/webrtc/rtmp config is
patched through the per-app `PATCH /apps/{app}/config` (see [api-app.md](./api-app.md)).
S3 credentials are **never** accepted here.

**Auth**: Bearer. **Path**: `name`.

**Body** (`UpdateAppConfigDto`)

| Field | Type | Notes |
|-------|------|-------|
| `displayName` | string | ≤ 100 |
| `roomPrefix` | string | slug `^[a-z0-9][a-z0-9-]{0,39}$` |
| `recordingEnabled` | boolean | toggles `recording.enabled` |
| `callbackUrl` | string | ≤ 2048; outbound callback URL |
| `callbackSecret` | string | ≤ 256; HMAC signing secret |

```json
{ "displayName": "Live channel", "recordingEnabled": true, "callbackUrl": "https://hooks.example.com/streamhub" }
```

**Response 200** — merged `AppConfig` (see [config-reference.md](./config-reference.md)
for the full shape). **404** if app not found.

**curl**

```bash
curl -s -X PATCH https://streamhub.example.com/api/v1/apps/live \
  -H "Authorization: Bearer $STREAMHUB_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"recordingEnabled":true,"callbackUrl":"https://hooks.example.com/streamhub"}'
```

---

## DELETE /apps/{name}

Delete an app. Optionally purge its VODs / local files / S3 objects.

**Auth**: Bearer. **Path**: `name`.

**Query**

| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `deleteVods` | boolean | `false` | If `true`, also delete the app's VODs and local files |

**Response 200**

```json
{ "deleted": true, "name": "demo" }
```

**404** if not found.

**curl**

```bash
curl -s -X DELETE "https://streamhub.example.com/api/v1/apps/demo?deleteVods=true" \
  -H "Authorization: Bearer $STREAMHUB_TOKEN"
```

---

## GET /tokens

List API tokens. Token hashes and plaintexts are **never** returned.

**Auth**: Bearer.

**Response 200** — array of `TokenSummary`:

```json
[
  {
    "id": 1,
    "name": "ui-server",
    "scope": "global",
    "appId": null,
    "lastUsedAt": null,
    "createdAt": "2026-06-30 12:00:00",
    "revoked": false
  }
]
```

**curl**

```bash
curl -s https://streamhub.example.com/api/v1/tokens \
  -H "Authorization: Bearer $STREAMHUB_TOKEN"
```

---

## POST /tokens

Create an API token. **The plaintext token is returned ONCE** — store it immediately.
Only the SHA-256 hash is persisted.

**Auth**: Bearer.

**Body** (`CreateTokenDto`)

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `name` | string | yes | ≤ 100 |
| `scope` | `global` \| `app` | yes | |
| `appId` | number | when `scope=app` | numeric app id |
| `allowedIps` | string[] | no | IP whitelist (exact IP or IPv4 CIDR) |

```json
{ "name": "ui-server", "scope": "global", "allowedIps": ["127.0.0.1"] }
```

**Response 201** (`CreatedTokenDto`)

```json
{ "id": 2, "token": "sk_2Qf...returned-once..." }
```

Tokens are prefixed `sk_`.

**curl**

```bash
curl -s -X POST https://streamhub.example.com/api/v1/tokens \
  -H "Authorization: Bearer $STREAMHUB_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"ui-server","scope":"global","allowedIps":["127.0.0.1"]}'
```

---

## DELETE /tokens/{id}

Revoke (soft-delete) an API token. The token row is kept but marked `revoked` and stops
authenticating.

**Auth**: Bearer. **Path**: `id` (integer).

**Response 204 No Content.**

**curl**

```bash
curl -s -X DELETE https://streamhub.example.com/api/v1/tokens/2 \
  -H "Authorization: Bearer $STREAMHUB_TOKEN"
```

---

## GET /logs

Query structured server logs (from the `server_logs` table). Newest first, paginated.

**Auth**: Bearer.

**Query** (`LogQueryDto`)

| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `app` | string | — | Filter by app name (≤ 64) |
| `level` | enum | — | `trace`\|`debug`\|`info`\|`warn`\|`error`\|`fatal` |
| `source` | string | — | Exact match on the emitting subsystem (≤ 64) |
| `q` | string | — | Free-text search over the message (`LIKE %…%`, metacharacters escaped; ≤ 200) |
| `since` | ISO-8601 | — | Lower bound (inclusive) |
| `until` | ISO-8601 | — | Upper bound (inclusive) |
| `limit` | int | 100 | 1..1000 |
| `offset` | int | 0 | ≥ 0 |

> **Per-app attribution**: rows carry `appId` when the emitter tagged the log
> with its app (most do). Filtering by `app` resolves the name → id and matches
> those rows. A per-app viewer with the same filters (minus `app`) lives at
> [`GET /apps/{app}/logs`](./api-app.md#get-appsapplogs).

**Response 200** (paginated envelope)

```json
{
  "data": [
    {
      "id": 42,
      "ts": "2026-06-30T12:00:00.000Z",
      "level": "info",
      "source": "livekit-webhook",
      "appId": 1,
      "message": "event egress_ended",
      "metaJson": "{\"room\":\"live-demo\"}"
    }
  ],
  "total": 1,
  "limit": 100,
  "offset": 0
}
```

**curl**

```bash
curl -s "https://streamhub.example.com/api/v1/logs?app=live&level=error&limit=50" \
  -H "Authorization: Bearer $STREAMHUB_TOKEN"
```

---

## System settings

Read-only view of THIS core's **effective configuration** plus per-group **guidance**
on how to change each setting. It powers the dashboard "Server settings" page: the panel
_shows_ the config and gives copy-paste commands — it **never writes** anything and the
API has no mutation route.

**Bearer, global-scope** (superadmin). An app-scoped token gets `403`; anonymous gets `401`.

### GET /system/settings

Returns the config **with every secret redacted**. JWT / API / admin / cluster / SMTP
secrets and the Redis password are **never** returned — only `…Set` booleans, an
`apiKeyMasked` (first 6 chars + `…`), and `redisUrl` reduced to `host:port`.
`authzEnforce` is shown verbatim on purpose — it is a security **mode** (`off` | `log` |
`on`), not a secret.

**Auth**: Bearer (global-scope).

**Response 200**

```json
{
  "data": {
    "core": {
      "nodeEnv": "production",
      "port": 3020,
      "host": "127.0.0.1",
      "publicBaseUrl": "https://streamhub.example.com",
      "publicWsUrl": "wss://streamhub.example.com",
      "rtmpPublicHost": "streamhub.example.com",
      "logLevel": "info",
      "logRetentionDays": 30,
      "authzEnforce": "on",
      "redisUrl": "127.0.0.1:6379",
      "dataDir": "/opt/streamhub-core"
    },
    "auth": {
      "adminUser": "admin",
      "jwtSecretSet": true,
      "adminPassSet": true,
      "smtpConfigured": true,
      "superadminEmail": "info@streamhub.studio"
    },
    "livekit": { "url": "ws://127.0.0.1:7880", "apiKeySet": true, "apiKeyMasked": "APIabc…" },
    "cluster": { "enabled": true, "redisConfigured": true, "nodesCount": 2 },
    "metrics": { "tokenSet": true },
    "storage": { "dataDir": "/opt/streamhub-core", "dbSizeBytes": 245760, "appsCount": 3 },
    "versions": { "core": "0.1.0", "node": "v20.11.1" },
    "runtime": { "uptimeSeconds": 86400, "pid": 12345, "platform": "linux", "memoryRssBytes": 104857600 },
    "ports": {
      "core": 3020, "livekitSignaling": 7880, "livekitTcp": 7881,
      "livekitUdp": 7882, "rtmp": 1935, "whip": 8080
    },
    "guidance": {
      "core": [
        {
          "setting": "Enforcement de permisos",
          "envVar": "STREAMHUB_AUTHZ_ENFORCE",
          "howToChange": "… Editá `STREAMHUB_AUTHZ_ENFORCE` en el `.env` del server y reiniciá el core: `systemctl restart streamhub-core`."
        }
      ]
    }
  },
  "error": null
}
```

**Errors**: `401` anonymous; `403` for an app-scoped (non-superadmin) token.

**curl**

```bash
curl -s https://streamhub.example.com/api/v1/system/settings \
  -H "Authorization: Bearer $STREAMHUB_TOKEN"
```

---

## Cluster

Edge-node registry for the one-liner installer plus the dashboard **cluster manager**.
`/join` and `/heartbeat` are **not** Bearer-authenticated — they authenticate with the
`X-Cluster-Token` header (matched against `STREAMHUB_CLUSTER_TOKEN`, see
[operations/ENV.md](./operations/ENV.md)). If that env is unset the two node-facing
endpoints return **503**. The manager surface — `/info`, `GET/PATCH/DELETE` on
`/nodes` — is Bearer, **global-scope** (an app-scoped token gets `403`). The registry
never stores secrets.

### POST /cluster/join

Register (or refresh) an edge node. **Idempotent by node `name`**: a re-run keeps the
node's `id` and just refreshes its `url`/`region`/`status`/`last_seen_at`. The response
hands the node the bootstrap config it needs to attach to the LiveKit control plane.

**Auth**: `X-Cluster-Token: <STREAMHUB_CLUSTER_TOKEN>`.

**Body** (`JoinNodeDto`)

| Field | Type | Required | Rules |
|-------|------|----------|-------|
| `name` | string | yes | `^[a-zA-Z0-9._-]+$`, 1–64 chars (the upsert key) |
| `ip` | string | yes | Valid IPv4 or IPv6 |
| `region` | string | no | ≤ 64 chars |
| `url` | string | no | ≤ 255 chars; public URL — falls back to `ip` when omitted |

```json
{ "name": "edge-fra-1", "ip": "203.0.113.10", "region": "eu-central" }
```

**Response 201** (new) / **200** (refresh)

```json
{
  "data": {
    "nodeId": "4b2f0c2e-1a3d-4c5e-8f9a-0b1c2d3e4f5a",
    "name": "edge-fra-1",
    "redisUrl": "redis://cluster-redis:6379",
    "publicWsUrl": "wss://streamhub.example.com",
    "livekit": { "apiKey": "API…", "apiSecret": "…", "wsUrl": "ws://127.0.0.1:7880" }
  },
  "error": null
}
```

`redisUrl` / `publicWsUrl` are `null` when their env is unset.

**Errors**: `503` if `STREAMHUB_CLUSTER_TOKEN` is unset; `401` on a missing/wrong
`X-Cluster-Token`; `400` on validation.

**curl**

```bash
curl -s -X POST https://streamhub.example.com/api/v1/cluster/join \
  -H "X-Cluster-Token: $STREAMHUB_CLUSTER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"edge-fra-1","ip":"203.0.113.10","region":"eu-central"}'
```

---

### POST /cluster/heartbeat

Mark an already-joined node alive (sets `status=active`, refreshes `last_seen_at`).
May carry an optional free-form `stats` blob that is persisted verbatim
(last-write-wins) and surfaced, parsed, on `GET /cluster/nodes`.

**Auth**: `X-Cluster-Token`.

**Body** (`HeartbeatDto`)

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `nodeId` | string | yes | The `nodeId` returned by `/cluster/join` |
| `stats` | object | no | Free-form node stats (e.g. `cpu`, `mem`, `activeStreams`). Capped at **~4KB serialized** (`413` over the limit). Omit for a bare liveness ping — the previous blob is kept. |

```json
{ "nodeId": "4b2f0c2e-…", "stats": { "cpu": 0.42, "activeStreams": 3 } }
```

**Response 200**

```json
{ "data": { "ok": true }, "error": null }
```

**Errors**: `503` if disabled; `401` on a bad token; `404` if the node is unknown;
`413` if `stats` exceeds ~4KB serialized.

**curl**

```bash
curl -s -X POST https://streamhub.example.com/api/v1/cluster/heartbeat \
  -H "X-Cluster-Token: $STREAMHUB_CLUSTER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"nodeId":"4b2f0c2e-1a3d-4c5e-8f9a-0b1c2d3e4f5a","stats":{"cpu":0.42}}'
```

---

### GET /cluster/info

Cluster overview for the dashboard cluster manager: whether clustering is enabled,
the node count, the cluster token + Redis URL, and a ready-to-copy **join one-liner**
for a new edge box. The token is returned on purpose — this is a global/superadmin
surface and the operator needs it to build the join command.

**Bearer, global-scope** (an app-scoped token is rejected with `403`).

**Auth**: Bearer.

**Response 200**

```json
{
  "data": {
    "enabled": true,
    "nodesCount": 3,
    "clusterToken": "clt_…",
    "clusterRedisUrl": "redis://cluster-redis:6379",
    "joinCommand": "curl -fsSL https://www.streamhub.studio/install.sh | sudo bash -s -- --join --master-token clt_… --master-ip <THIS_SERVER_IP> --master-url https://media.example.com"
  },
  "error": null
}
```

`enabled` is `false` (and `clusterToken` empty) when `STREAMHUB_CLUSTER_TOKEN` is unset.
`clusterRedisUrl` is `null` when `STREAMHUB_CLUSTER_REDIS_URL` is unset. `<THIS_SERVER_IP>`
is a literal placeholder — the server cannot know its own public IP at runtime; the
operator substitutes it (`--master-url` comes from `STREAMHUB_PUBLIC_URL`).

**curl**

```bash
curl -s https://streamhub.example.com/api/v1/cluster/info \
  -H "Authorization: Bearer $STREAMHUB_TOKEN"
```

---

### GET /cluster/nodes

List every registered node. **Bearer, global-scope** (an app-scoped token is rejected
with `403`, like the other admin surfaces).

**Auth**: Bearer.

**Response 200** — array of node rows (no secrets). Each row carries the parsed last
heartbeat `stats` (`null` until reported) and a derived `stale` flag (`true` when the
node's `last_seen_at` is older than **90s**, or it never reported — drives the status
dot in the dashboard):

```json
{
  "data": [
    {
      "id": "4b2f0c2e-1a3d-4c5e-8f9a-0b1c2d3e4f5a",
      "name": "edge-fra-1",
      "url": "203.0.113.10",
      "region": "eu-central",
      "status": "active",
      "created_at": "2026-06-30 12:00:00",
      "last_seen_at": "2026-06-30 12:05:00",
      "stats": { "cpu": 0.42, "activeStreams": 3 },
      "stale": false
    }
  ],
  "error": null
}
```

**curl**

```bash
curl -s https://streamhub.example.com/api/v1/cluster/nodes \
  -H "Authorization: Bearer $STREAMHUB_TOKEN"
```

---

### PATCH /cluster/nodes/{id}

Update a registered node's `name`, `region` and/or administrative `status` from the
dashboard cluster manager. Every field is optional (patch just what changed); an empty
body is a no-op that returns the current row.

**Bearer, global-scope**.

**Auth**: Bearer.

**Body** (`PatchNodeDto`)

| Field | Type | Required | Rules |
|-------|------|----------|-------|
| `name` | string | no | `^[a-zA-Z0-9._-]+$`, 1–64 chars |
| `region` | string | no | ≤ 64 chars |
| `status` | string | no | One of `active`, `draining`, `disabled` |

**Response 200** — the updated node row (same shape as `GET /cluster/nodes`).

**Errors**: `403` for an app-scoped token; `404` if the node is unknown; `400` on validation.

**curl**

```bash
curl -s -X PATCH https://streamhub.example.com/api/v1/cluster/nodes/4b2f0c2e-… \
  -H "Authorization: Bearer $STREAMHUB_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"status":"draining"}'
```

---

### DELETE /cluster/nodes/{id}

Remove a node from the registry (dashboard cluster manager).

**Bearer, global-scope**.

**Auth**: Bearer.

**Response 200**

```json
{ "data": { "id": "4b2f0c2e-…", "deleted": true }, "error": null }
```

**Errors**: `403` for an app-scoped token; `404` if the node is unknown.

**curl**

```bash
curl -s -X DELETE https://streamhub.example.com/api/v1/cluster/nodes/4b2f0c2e-… \
  -H "Authorization: Bearer $STREAMHUB_TOKEN"
```
