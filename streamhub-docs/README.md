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

### Start here — [`PROJECT-MAP.md`](./PROJECT-MAP.md)
Repo orientation: annotated project tree, component & library versions (pins), and
a verified "build your first plugin" quickstart.

### Architecture — [`architecture/`](./architecture/README.md)
How it's built and where it's going.
- [architecture/services.md](./architecture/services.md) — single-node service map, ports,
  request routing, the single-binary Go core, deploy shapes. *(mermaid)*
- [architecture/data-model.md](./architecture/data-model.md) — per-app SQLite: minimal global
  `streamhub.db` + `apps/<app>/app.db`, the idempotent split migration. *(mermaid)*
- [architecture/cluster.md](./architecture/cluster.md) — target origin+edge cluster, node
  registry/join, WebRTC affinity, and the WebRTC-vs-HLS/CDN reality check. *(mermaid)*

### Operations — [`operations/`](./operations/README.md)
How to deploy, run and observe it.
- [operations/INSTALL-NODE.md](./operations/INSTALL-NODE.md) — the hosted one-liner installer
  (`curl … | sudo bash`, Ubuntu 24.04/26.04 x64): day-0 origin install, day-1 `--join` edge
  nodes, and how the script is hosted at `www.streamhub.studio/install.sh`.
- [operations/MANUAL-BUILD-INSTALL.md](./operations/MANUAL-BUILD-INSTALL.md) — build from source
  & manual install, step by step (Go core + SPA + SDK → one core image, `.env`, `docker compose
  up` + seed-token, verify, `DATA_DIR`, manual node join) — then what the one-liner automates.
- [operations/CLUSTER-UPDATES.md](./operations/CLUSTER-UPDATES.md) — updating master + joined
  common/edge nodes: `streamhub upgrade`, `--version` pinning as rollback, master-first order,
  verifying rejoin, health-fail rollback.
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
broadcast, quotas. The product master spec is [`SPEC.md`](./SPEC.md); historical wave design
notes live in [`history/`](./history/README.md).

### Development — [`development/`](./development/EXTENDING-STUDIO-APPS.md)
Build your own extension.
- [development/EXTENDING-STUDIO-APPS.md](./development/EXTENDING-STUDIO-APPS.md) — developing your
  own Studio App / plugin (incl. edge workers): plugin meta anatomy, frontend `PluginModule`
  discovery, writing a Python worker, the framework-owned worker lifecycle, export bundles, the
  dev-loop options, and the edge angle. Pairs with [features/plugins.md](./features/plugins.md) +
  [features/STUDIO-APPS.md](./features/STUDIO-APPS.md).

### Testing — [`testing/`](./testing/TESTING-STRATEGY.md)
Test strategy, unit tests, functional simulations / post-deploy verification and
the manual QA reference —
[TESTING-STRATEGY.md](./testing/TESTING-STRATEGY.md), [UNIT-TESTS.md](./testing/UNIT-TESTS.md),
[FUNCTIONAL-SIMULATIONS.md](./testing/FUNCTIONAL-SIMULATIONS.md),
[MANUAL-QA.md](./testing/MANUAL-QA.md) — exhaustive by-hand validation guide (Spanish, basic-tester level).

### Integrations — [`integrations/`](./integrations/README.md)
Native/device clients (Android, iOS, C++, ESP32-CAM) and which protocol each uses.

---

## Naming

The product is **StreamHub**; the repository is `vision-media-server`. On the original
production host (`media01`) some directories and systemd units still use the historical
`skyline-*` prefix — treat them as aliases of the `streamhub-*` names in these docs.

---

## License

StreamHub follows an **open-core** model. The self-hosted core in this repository —
`streamhub-core-go/`, `streamhub-web/`, `deploy/` and the Compose stack — is open source under
**AGPL-3.0-only** (see [`LICENSE`](../LICENSE) at the repo root). The worker-backed Studio Apps
(`yolo`, `deface`, `lpr`, `perimeter`, `presence`, `people-counter`, `safety-ppe`,
`transcription`, and the vision four `occupancy`/`counting`/`crowd`/`demography`) moved out of
this repo into their own AGPL-3.0 repos (`gitlab:digitalhub_com_ar/streamhub-app-<id>`) as part
of the 2.20.0–2.23.0 app-decoupling program — see
[`history/2026-07-13-decoupling-and-feature-waves.md`](./history/2026-07-13-decoupling-and-feature-waves.md)
and [`development/PACKAGE-FORMAT.md`](./development/PACKAGE-FORMAT.md). The browser SDK
[`streamhub-adaptor/`](../streamhub-adaptor/) is intentionally **MIT** so it can be embedded
drop-in in any client app. Commercial **Enterprise Edition (EE)** modules are distributed and
licensed separately and are not part of this repo.
