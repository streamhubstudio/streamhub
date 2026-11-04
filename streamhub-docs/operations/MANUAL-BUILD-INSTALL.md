# Build from source & manual install, step by step

This is the **do-it-by-hand** companion to [INSTALL.md](./INSTALL.md). The
one-liner installer ([INSTALL-NODE.md](./INSTALL-NODE.md)) automates every step
below; this guide walks the same steps manually so you understand exactly what
lands where. If you just want a running server, use the installer — skip to
[§9 "The automated path"](#9-the-automated-path) to see what it does for you.

Everything here targets **shape A** (Docker Compose + Caddy). For the bare-metal
**systemd + nginx + certbot** shape (LiveKit and core as native units, ingress/
egress as containers) see [DEPLOY.md §B](./DEPLOY.md#b-systemd--nginx--certbot-plain-server).

---

## 1. Prerequisites

- A **Linux host with a public IP** (VPS/Hetzner/DigitalOcean/EC2, etc.).
  LiveKit uses host networking for UDP media and STUN external-IP detection, so
  Docker Desktop on macOS/Windows is **not** a deployment target — build there if
  you like, but run the stack on Linux.
- **Docker** + the **Compose v2 plugin** — `docker compose version` must work.
- **Node 24** — only needed if you build components outside Docker (the
  `deploy/Dockerfile` stages all pin `node:24-bookworm`). Verify with `node -v`.
- **Python 3** — only needed on the host if you run the CV/worker plugins
  *outside* the container; the core image already ships a `python3` venv for the
  baked workers. Not required just to run the media server.
- Open firewall ports: `80,443/tcp` (Caddy: dashboard + API + `/rtc`),
  `7880/tcp` (LiveKit signaling), `7881/tcp` (LiveKit TCP fallback),
  `7882/udp` (LiveKit media), `1935/tcp` (RTMP ingest), `8080/tcp` (WHIP).
- For a real domain: a DNS **A record** to the host (DNS-only — do **not** proxy
  through Cloudflare; WebRTC media is UDP).

---

## 2. Get the source

The product repo is private; the installer normally fetches a **source tarball**.
By hand you either clone (if you have access) or unpack the tarball into your
install dir. The examples use `/opt/streamhub` — the installer's default
`$INSTALL_DIR` — but any directory works.

```bash
sudo mkdir -p /opt/streamhub && cd /opt/streamhub
# ... place the source tree here (git checkout or an unpacked release tarball) ...
# The tree is "flat": docker-compose.yml sits at the root, next to
# streamhub-core-go/ streamhub-web/ streamhub-adaptor/ deploy/ and VERSION
# (plugins-vendor/ holds the decoupled apps once `streamhub-core apps pull`
# composed them).
cat VERSION      # the release version, e.g. 2.15.0
```

The release tarball is produced by `deploy/make-release-artifact.sh` (the same
builder CI uses) — see [INSTALL.md §8](./INSTALL.md#8-build-a-test-artifact-locally)
if you want to roll your own.

---

## 3. Understand the build — Go core + two JS bundles into one image

StreamHub ships as **one core container** that serves everything. The multi-stage
`deploy/Dockerfile` (build context = repo root) compiles the Go core plus two
build-time-only JS components and assembles them:

| Stage | Component | Command | Output | Where it lands in the image |
|---|---|---|---|---|
| `web` | `streamhub-web/` (React 19 + Vite + Tailwind 4) | `npm ci && npm run build` | `dist/` | `→ /app/web` (served by the core from `./web` next to the binary) |
| `adaptor` | `streamhub-adaptor/` (tsup → IIFE) | `npm ci && npm run build` | `dist/*.global.js` | `→ /app/adaptor-dist` (entrypoint copies to `<DATA_DIR>/sdk` at boot) |
| `core` | `streamhub-core-go/` (Go, `golang:1.26-alpine`) | `CGO_ENABLED=0 go build -trimpath -ldflags "-X …version.Override=<VERSION>"` | one static binary | `→ /app/streamhub-core` (+ `/usr/local/bin/streamhub-core` alias) |
| `vendor` | `plugins-vendor/` (repo root; if `streamhub-core apps pull` ran) | copy | composed decoupled apps | `→ /app/plugins-vendor` |

The runtime stage (`debian:bookworm-slim`) copies those outputs plus repo-root
`VERSION` (also baked into the binary; read by `/api/v1/health` and shown in the
dashboard footer), then adds:

- **Core runtime deps** — `ca-certificates`, `tzdata`, `ffmpeg`/`ffprobe` (the
  core's own media tools: snapshots, VOD transcode, passthrough remux), `sqlite3`
  (operator backups), and `python3` + `python3-venv` to host the worker apps.
- **Python worker venv** at `/opt/workers/venv` (`PLUGIN_PYTHON`). The composed
  apps' worker source rides inside `/app/plugins-vendor/<id>/worker`; the build arg
  `INSTALL_VENDORED_WORKER_DEPS` (default `deface`; a comma list, `all`, or `0`)
  chooses whose pip deps are baked.
- **No Node.** The stream-health worker is the core binary's own
  `streamhub-core health-worker` subcommand.
- **Studio-App export sources** — `STREAMHUB_WORKER_SRC_ROOT=/opt/worker-src`
  (the repo LICENSE; app sources come from `plugins-vendor`). See
  [EXTENDING-STUDIO-APPS.md](../development/EXTENDING-STUDIO-APPS.md).

The container healthcheck is the binary itself (`streamhub-core healthcheck`).
**So SPA and SDK changes ship by rebuilding the core image** — there is no
separate web deployment.

### 3a. (Optional) build a component by hand

You never need to run these for a Compose deploy — the image does them — but this
is exactly what each stage runs, if you want to build or iterate outside Docker:

```bash
cd streamhub-web        && npm ci && npm run build   # → dist/  (the SPA)
cd ../streamhub-adaptor && npm ci && npm run build   # → dist/streamhub-adaptor.global.js
cd ../streamhub-core-go && CGO_ENABLED=0 go build -trimpath -o bin/streamhub ./cmd/streamhub
# run it: DATA_DIR=/tmp/sh WEB_DIR=../streamhub-web/dist ./bin/streamhub
```

The Go core is pure Go (SQLite via `modernc.org/sqlite`) — no C toolchain needed.
`deploy/make-core-bundle.sh` packs the same three outputs into the plain-server
bundle (see [DEPLOY.md §B](./DEPLOY.md)).

---

## 4. Configure — the single `.env`

All configuration is one `.env` at the tree root. Start from the fully-commented
example and fill in the essentials:

```bash
cp .env.example .env
chmod 600 .env
```

Minimum to set by hand (the installer generates these as strong random values):

- `STREAMHUB_DOMAIN` — your domain (or a bare IP for a no-TLS box).
- `ACME_EMAIL` — Let's Encrypt contact (Caddy auto-TLS).
- `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` — the SFU keys (must match cluster-wide
  if you add nodes later).
- `STREAMHUB_JWT_SECRET` — signs dashboard JWTs.
- `ADMIN_USER` / `ADMIN_PASS` — break-glass dashboard login.
- `STREAMHUB_API_TOKEN` — the global `sk_…` REST token you seed in §6.

Every variable, its default and its meaning is catalogued in
[ENV.md](./ENV.md). A bare IP in `STREAMHUB_DOMAIN` (or setting the no-TLS mode)
switches public URLs to `http://`/`ws://` and skips ACME.

---

## 5. Bring the stack up

```bash
docker compose up -d --build
docker compose ps          # wait for services to report healthy
```

`docker-compose.yml` defines the core services, all on the **host network** so
they reach each other over `127.0.0.1` (the LiveKit-recommended layout for media):

| Service | Image | Role |
|---|---|---|
| `redis` | `redis:7-alpine` | LiveKit ingress/egress coordination (the core's own jobs/schedules run in-process) |
| `livekit` | `livekit/livekit-server:v1.8.4` | the SFU (config from `.env`; webhooks → core) |
| `ingress` | LiveKit ingress | RTMP/WHIP ingest |
| `egress` | LiveKit egress | room-composite recording (bind-mounts `DATA_DIR`) |
| `core` | `streamhub-core:local` (built from `deploy/Dockerfile`) | the Go core: API + SPA + SDK on `:3020`, owns SQLite + jobs |
| `caddy` | `caddy:2-alpine` (`deploy/Caddyfile`) | TLS on `:80/:443`; routes `/rtc*` → LiveKit, everything else → core |

There are additional **opt-in** services in the compose file (a `mediamtx`
single-port RTMP front and an `rtmps` terminator) — they stay off unless enabled;
the six above are the default stack. Egress bind-mounts the data dir at the same
path the core uses, so the MP4 it writes lands exactly where core looks to upload
it to the app's S3 bucket.

---

## 6. Seed the global API token

The REST API is guarded by `sk_` bearer tokens. Seed the one from your `.env`
into the DB (idempotent):

```bash
grep '^STREAMHUB_API_TOKEN=' .env | cut -d= -f2 \
  | docker compose exec -T core streamhub-core seed-token - bootstrap
```

(stdin form: the token never shows in `ps`. The argv form
`streamhub-core seed-token <sk_token> [name]` also works.)

---

## 7. Verify

```bash
curl http://127.0.0.1:3020/api/v1/health          # {"status":"ok",...}
curl -H "Authorization: Bearer $STREAMHUB_API_TOKEN" \
     https://<your-domain>/api/v1/stats            # authed call through Caddy
# Dashboard: https://<your-domain>/         (login: ADMIN_USER / ADMIN_PASS)
# Swagger:   https://<your-domain>/api/v1/docs
```

`/metrics` is scraped locally on the host (`127.0.0.1:3020/metrics`) and denied
from outside. For a full post-deploy smoke test (push RTMP, record, confirm the
VOD lands in S3) see [DEPLOY.md §"Post-deploy smoke test"](./DEPLOY.md#post-deploy-smoke-test).

---

## 8. Where the data lives — `DATA_DIR`

`STREAMHUB_HOST_DATA_DIR` on the host (default `./data`) is bind-mounted as
`DATA_DIR` (`/data`) into **both** core and egress. The entrypoint creates its
subtree on first boot and copies the adaptor IIFE into `sdk/`:

```
DATA_DIR/
├── data/streamhub.db          # minimal global registry (tenants, users, tokens, nodes, apps pointer)
├── apps/<app>/
│   ├── app.db                 # per-app state (streams, vods, ingress_auth)
│   ├── config.yaml            # per-app runtime config (features:, S3 refs) — see config-reference.md
│   ├── recordings/ snapshots/ hls/ samples/
│   └── <plugin>/…             # per-app plugin storage (e.g. lpr/lpr.db + snapshots)
├── secrets.json               # per-app S3 creds (chmod 600), referenced from config.yaml
├── logs/
└── sdk/streamhub-adaptor.global.js   # the browser SDK, served at /sdk/
```

A global→per-app split migration runs idempotently at **core boot** (after a
`VACUUM INTO` backup of the global DB); you never run migrations by hand. Details:
[DEPLOY.md §"DB migration"](./DEPLOY.md#db-migration--automatic-idempotent-backed-up).

For per-app S3 credentials (recording target), drop them in `data/secrets.json`
and reference them from the app's `config.yaml` — see
[self-hosting.md §5](./self-hosting.md#5-per-app-s3-recording-target).

---

## 9. The automated path

Everything above is what this one line does for you — fetch source, generate a
`.env` with strong secrets, `docker compose up -d --build`, wait for health, seed
the token, install the `streamhub` CLI + systemd unit + heartbeat timer, and
stamp `VERSION`:

```bash
curl -fsSL https://www.streamhub.studio/install.sh | sudo bash
```

Once installed, you manage the box through the **`streamhub` CLI** (never raw
`docker compose`): `streamhub status`, `streamhub logs core -f`,
`sudo streamhub upgrade`, `streamhub doctor`. Full CLI reference and the
idempotent, backed-up, rollback-able upgrade path are in
[INSTALL.md](./INSTALL.md); updating a whole cluster is in
[CLUSTER-UPDATES.md](./CLUSTER-UPDATES.md).

---

## 10. Adding another node (manual join)

Extra nodes join an existing origin/master over its API — no keys copied by hand.
On a fresh Linux box:

```bash
curl -fsSL https://www.streamhub.studio/install.sh | sudo bash -s -- \
  --join \
  --master-token clt_...        # the origin's cluster token (its .env STREAMHUB_CLUSTER_TOKEN)
  --master-ip 10.0.0.10         # the origin's PRIVATE IP (edges share its Redis)
  --master-url https://media.example.com   # optional: TLS master API base
  --node-name edge-1 --region eu-west \
  --node-type common            # 'common' = full media node (default); 'edge' = Vision Edge, no media plane
```

- `--node-type common` (default) starts only `livekit ingress egress` against the
  origin's Redis — the control plane stays on the origin.
- `--node-type edge` skips the media plane entirely and installs the Vision Edge
  runtime unit (dials the master's control WebSocket outbound; NAT-friendly). See
  [features/vision-edge.md](../features/vision-edge.md#node-types--installer-flag).

The join is **100% API**: the node registers with the token and receives the
LiveKit keys + Redis URL in the response. The critical requirement is that the
origin's Redis (6379) is reachable from the node over a **private** interface —
install the origin with `--cluster-redis-bind <origin-private-ip>`. Full flow,
the redis-preflight guard, and verification (`GET /api/v1/cluster/nodes`) are in
[INSTALL-NODE.md](./INSTALL-NODE.md).

---

## See also

- [INSTALL.md](./INSTALL.md) — the app-as-one-folder layout, the `streamhub` CLI,
  the managed systemd unit, upgrade/rollback, versioning + release pipeline.
- [INSTALL-NODE.md](./INSTALL-NODE.md) — the hosted one-liner installer and the
  `--join` edge flow in depth.
- [DEPLOY.md](./DEPLOY.md) — both deploy shapes, DB migration, SDK→`/sdk`, samples.
- [ENV.md](./ENV.md) — every environment variable.
- [CLUSTER-UPDATES.md](./CLUSTER-UPDATES.md) — updating master + edge + common nodes.
- [../development/EXTENDING-STUDIO-APPS.md](../development/EXTENDING-STUDIO-APPS.md) —
  build your own Studio App / plugin / edge worker.
</content>
</invoke>
