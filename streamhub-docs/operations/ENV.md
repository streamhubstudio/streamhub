# Operations — Environment variables

The canonical template is [`.env.example`](../../.env.example) at the repo root (used by
Docker Compose and `install.sh`). This is the annotated reference. Secrets are **never**
committed. Anything ending in `_SECRET`/`_PASS`/`_TOKEN` must be long and random in prod.

## Public identity / TLS (Compose + installer)

| Var | Default | Meaning |
|---|---|---|
| `STREAMHUB_DOMAIN` | `streamhub.example.com` | The single public domain Caddy fronts (dashboard + API + `/rtc`). Real hostname with a **DNS-only** A record (not Cloudflare-proxied — WebRTC is UDP). `localhost` for a local self-signed test. |
| `ACME_EMAIL` | `admin@example.com` | Let's Encrypt / ACME registration email (real domains only). |

## LiveKit (shared by server + ingress + egress)

| Var | Default | Meaning |
|---|---|---|
| `LIVEKIT_API_KEY` | `APIchangeme…` | LiveKit API key. `livekit-server generate-keys` (installer generates one). |
| `LIVEKIT_API_SECRET` | change-me | LiveKit API secret. |
| `LIVEKIT_URL` | `ws://127.0.0.1:7880` | How core reaches LiveKit locally (control plane). |

## streamhub-core runtime

| Var | Default | Meaning |
|---|---|---|
| `HOST` | `127.0.0.1` | Local bind of core (the reverse proxy targets this). |
| `PORT` | `3020` | Core HTTP port. |
| `PUBLIC_WS_URL` | `wss://<domain>` | ws/wss URL handed to browser clients in join links/tokens. Localhost: `ws://127.0.0.1:7880`. |
| `RTMP_PUBLIC_HOST` | `<domain>` | Public host advertised for RTMP push URLs. |
| `PUBLIC_BASE_URL` / `STREAMHUB_PUBLIC_URL` | derived from domain | Base URL used to build player/embed/sample URLs. |
| `REDIS_URL` | `redis://127.0.0.1:6379` | Redis for LiveKit ingress/egress coordination **and** BullMQ job queues. |
| `NODE_ENV` | `production` | Node environment. |

## Auth / RBAC

| Var | Default | Meaning |
|---|---|---|
| `STREAMHUB_JWT_SECRET` | change-me | Signs the dashboard login JWT (`POST /api/v1/auth/login`). |
| `ADMIN_USER` | `admin` | Break-glass dashboard admin user. Login disabled if user or pass is empty. |
| `ADMIN_PASS` | change-me | Break-glass admin password. |
| `STREAMHUB_API_TOKEN` | `sk_change_me` | Global API bearer token (`Authorization: Bearer sk_…`). Stored here only so re-running the installer stays idempotent; the DB keeps a hash. Seeded via `deploy/seed-token.js`. |
| `STREAMHUB_AUTHZ_ENFORCE` | `on` | RBAC + quota + per-app-token isolation mode: `off` \| `log` \| `on`. **Default is now `on`** (secure-by-default, Fase-0). `log` runs the same checks but only **logs** what they would block (use it to migrate a deployment that ran unenforced). In every mode GLOBAL `sk_` tokens and the break-glass admin bypass RBAC; only **app-scoped** `sk_` tokens are confined to their own app. |
| `AUTH_RATE_LIMIT_MAX` | `10` | Max attempts per client IP per window on the SENSITIVE auth routes only (login, magic-link, magic/verify, reset-request, reset). The rest of the API (incl. dashboard polling) is not limited. Exceeding it → `429`. |
| `AUTH_RATE_LIMIT_WINDOW_MS` | `900000` | Rate-limit window in ms (default 15 min) for the auth routes above. |
| `STREAMHUB_ALLOW_SIGNUP` | (unset → off) | Enables PUBLIC self-signup (`POST /auth/signup` + the "Create account" flow in the dashboard). `1`/`true`/`on`/`yes` → anyone can create an account + their own free-plan tenant. Unset/anything else → **invite-only**: a brand-new email gets `403 signup_disabled`; an invited *pending* user can still complete signup. Surfaced to the SPA via `GET /auth/config`. |
| `STREAMHUB_SUPERADMIN_EMAIL` | `info@streamhub.studio` | Email that becomes the superadmin principal when it signs in via magic-link. |
| `STREAMHUB_APP_URL` | `https://app.streamhub.studio` | Public base URL of the dashboard used to build magic-link / invite / reset URLs in emails. |

## Email (SMTP — magic links, invites, password resets)

| Var | Default | Meaning |
|---|---|---|
| `STREAMHUB_SMTP_HOST` | `mail.wipermax.online` | SMTP server. Without host+pass every send is skipped (logged, never crashes the request). |
| `STREAMHUB_SMTP_PORT` | `587` | `587` → STARTTLS; `465` → implicit TLS. |
| `STREAMHUB_SMTP_USER` | `no-reply@streamhub.studio` | SMTP auth user. |
| `STREAMHUB_SMTP_PASS` | (unset, **required** to send) | SMTP password — secret, never logged. |
| `STREAMHUB_SMTP_FROM` | `StreamHub <no-reply@streamhub.studio>` | From header on outgoing mail. |

## Cluster (multi-node / edge nodes)

Used by the one-liner installer when a box joins an existing control plane
(`POST /api/v1/cluster/join`). On a single-node install both can stay unset.

| Var | Default | Meaning |
|---|---|---|
| `STREAMHUB_CLUSTER_TOKEN` | (unset) | Shared secret an edge node must send as `X-Cluster-Token` to `POST /cluster/join` and `/cluster/heartbeat`. **Unset/empty → joining is disabled** (the endpoints return `503`). Must be long and random in prod. |
| `STREAMHUB_CLUSTER_REDIS_URL` | (unset) | Redis URL handed back to a joining node so it attaches to the same LiveKit coordination Redis. Unset → returned as `null` in the join payload (the node keeps its local default). |

## Storage / data

| Var | Default | Meaning |
|---|---|---|
| `DATA_DIR` | `/data` | Path **inside** the containers where core (and egress) read/write: `data/streamhub.db`, `apps/<name>/{recordings,hls,snapshots,samples}`, `logs/`, `sdk/`. Must be identical for `core` and `egress`. |
| `STREAMHUB_HOST_DATA_DIR` | `./data` | Host path bind-mounted to `DATA_DIR` in both containers (Compose). |
| `SDK_DIR` | `<DATA_DIR>/sdk` | Where core serves `/sdk/*` (the browser SDK) from. |
| `STREAMHUB_SNAPSHOT_SOURCE` | (auto) | Override for the on-demand snapshot capture source. |

> Per-app **S3 credentials** are **not** env vars — they live in `data/secrets.json`
> (`chmod 600`), referenced from each app's `config.yaml` via `*_env` keys. See
> [`../config-reference.md`](../config-reference.md).

## Metrics

| Var | Default | Meaning |
|---|---|---|
| `METRICS_TOKEN` | (unset) | Guards `GET /metrics`. **Fase-0 default-deny:** UNSET → `/metrics` returns `404` (disabled, never leaks). Set it and `/metrics` requires a matching `Authorization: Bearer <token>` (or `?token=`). |
| `METRICS_DEFAULT_METRICS` | on | Set `off` to disable the default `process_*` / `nodejs_*` collectors. |

## Transcoding / GPU

| Var | Default | Meaning |
|---|---|---|
| `TRANSCODING_HWACCEL` | auto | Hardware-accel preference for transcoding (see `deploy/GPU.md`). |
| `GPU_DISABLE` | (unset) | Force CPU-only; skips GPU detection. |

## Logging

| Var | Default | Meaning |
|---|---|---|
| `LOG_LEVEL` | `info` | pino log level. |
| `LOG_MAX_BYTES` | `10485760` | Rotating log file size cap (10 MB). |
| `LOG_MAX_FILES` | `10` | Number of rotated log files kept (count cap). |
| `LOG_RETENTION_DAYS` | `30` | Retention window for operational logs: purges `server_logs` rows **and** rotated log files older than this. `0` disables age-based purging (the file count cap still applies). The DB purge runs ~1 min after boot and every 6 h. |

## Minimal production `.env`

```env
STREAMHUB_DOMAIN=streamhub.example.com
ACME_EMAIL=admin@example.com
LIVEKIT_API_KEY=API…            # generate-keys
LIVEKIT_API_SECRET=…            # long random
PUBLIC_WS_URL=wss://streamhub.example.com
RTMP_PUBLIC_HOST=streamhub.example.com
REDIS_URL=redis://127.0.0.1:6379
STREAMHUB_JWT_SECRET=…          # long random
ADMIN_USER=admin
ADMIN_PASS=…                    # strong
STREAMHUB_API_TOKEN=sk_…        # long random
STREAMHUB_AUTHZ_ENFORCE=log
DATA_DIR=/data
STREAMHUB_HOST_DATA_DIR=./data
LOG_LEVEL=info
NODE_ENV=production
```
