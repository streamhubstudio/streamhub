# StreamHub — Documentation

**StreamHub** is a **self-hosted, open-source media server built on
[LiveKit](https://livekit.io)** — a drop-in-style alternative to AntMedia. It wraps a LiveKit
SFU with a management layer that gives you:

- **Multi-tenant apps** — isolated namespaces, each with its own tokens, config and S3 bucket.
- **Ingest** — WebRTC publish, RTMP push, WHIP, and RTSP (via ffmpeg relay).
- **Playback** — WebRTC (sub-second) and **HLS** (`/hls/<app>/<room>/index.m3u8`), an
  embeddable player, and a drop-in browser SDK (`streamhub-adaptor`, an AntMedia
  `WebRTCAdaptor` shim over `livekit-client`) served at `/sdk/`.
- **Recording → per-app S3** — one API call: room-composite MP4 → the app's own bucket →
  snapshot + VOD, local file cleaned up. (Verified: 2× H.264 720p → Wasabi.)
- **Signed webhooks** (HMAC) on every event, plus MP4 split + snapshots.
- **REST API** (global + per-app) with Swagger at `/api/v1/docs`, guarded by `sk_` tokens.
- **React dashboard** (Vite + Tailwind) with a break-glass admin login (JWT).
- **RBAC + quotas** with a safe phased rollout (`off` → `log` → `on`).
- **Prometheus metrics** at `/metrics`.

Everything runs behind a **single domain** with automatic HTTPS, from one `docker compose up`
(or a systemd + nginx plain-server deploy). Repo: `vision-media-server`. Quick-install:
`curl -fsSL …/install.sh | bash`.

---

## Documentation map

### Architecture — [`architecture/`](./architecture/README.md)
How it's built and where it's going.
- [architecture/services.md](./architecture/services.md) — single-node service map, ports,
  request routing, the mono-Node core, deploy shapes. *(mermaid)*
- [architecture/data-model.md](./architecture/data-model.md) — per-app SQLite: minimal global
  `streamhub.db` + `apps/<app>/app.db`, the idempotent split migration. *(mermaid)*
- [architecture/cluster.md](./architecture/cluster.md) — target origin+edge cluster, node
  registry/join, WebRTC affinity, and the WebRTC-vs-HLS/CDN reality check. *(mermaid)*

### Operations — [`operations/`](./operations/README.md)
How to deploy, run and observe it.
- [operations/INSTALL-NODE.md](./operations/INSTALL-NODE.md) — the hosted one-liner installer
  (`curl … | sudo bash`, Ubuntu 24.04/26.04 x64): day-0 origin install, day-1 `--join` edge
  nodes, and how the script is hosted at `www.streamhub.studio/install.sh`.
- [operations/DEPLOY.md](./operations/DEPLOY.md) — build, `.env`, Compose+Caddy / systemd+nginx,
  idempotent DB migration with backup, SDK→`/sdk`, regenerate samples.
- [operations/RUNBOOK.md](./operations/RUNBOOK.md) — start/restart, health, `/metrics`,
  `db/optimize`, backups/restore, rollback.
- [operations/ENV.md](./operations/ENV.md) — every environment variable.
- [operations/OBSERVABILITY.md](./operations/OBSERVABILITY.md) — Prometheus + Grafana.

### API — [`api/`](./api/README.md) · [`api-global.md`](./api-global.md) · [`api-app.md`](./api-app.md) · [`webhooks.md`](./webhooks.md) · [`config-reference.md`](./config-reference.md)
The REST surface and per-app runtime config.
- [api/README.md](./api/README.md) — complete endpoint reference (every route, permission,
  the public play-token, static mounts, env vars).
- [api-global.md](./api-global.md) — server-wide: `/health`, `/stats`, `/apps`, `/tokens`,
  `/logs`; auth (Bearer + IP whitelist).
- [api-app.md](./api-app.md) — per-app: tokens, ingress, recording, VODs, streams, snapshots,
  config, transcoding, data/chat.
- [webhooks.md](./webhooks.md) — incoming LiveKit webhook + outbound signed app callbacks.
- [config-reference.md](./config-reference.md) — per-app `config.yaml`, incl. the `features:` block.

### Features — [`features/`](./features/README.md)
Per-feature deep-dives: apps/multi-tenancy, tokens, auth, ingress, recording, VOD, HLS-live,
broadcast, quotas. The product master spec is [`SPEC.md`](./SPEC.md).

### Testing — [`testing/`](./testing/TESTING-STRATEGY.md)
Test strategy, unit tests and functional simulations / post-deploy verification —
[TESTING-STRATEGY.md](./testing/TESTING-STRATEGY.md), [UNIT-TESTS.md](./testing/UNIT-TESTS.md),
[FUNCTIONAL-SIMULATIONS.md](./testing/FUNCTIONAL-SIMULATIONS.md).

### Integrations — [`integrations/`](./integrations/README.md)
Native/device clients (Android, iOS, C++, ESP32-CAM) and which protocol each uses.

---

## Naming

The product is **StreamHub**; the repository is `vision-media-server`.
