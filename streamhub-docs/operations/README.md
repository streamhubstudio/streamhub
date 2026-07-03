# StreamHub — Operations

Runbooks for deploying, running and observing StreamHub on a single node.

| Doc | Scope |
|-----|-------|
| [INSTALL-NODE.md](./INSTALL-NODE.md) | The hosted one-liner installer (`curl https://www.streamhub.studio/install.sh \| sudo bash`, Ubuntu 24.04/26.04 LTS x64, idempotent): day-0 origin install, day-1 `--join` edge nodes, hosting of the script. |
| [DEPLOY.md](./DEPLOY.md) | Build (core + web SPA), configure (`.env`), deploy both shapes (Docker Compose + Caddy, or systemd + nginx + certbot). Idempotent DB migration with automatic backup. Copy the browser SDK to `/sdk`, (re)generate per-app samples. |
| [RUNBOOK.md](./RUNBOOK.md) | Day-2: start/restart, health checks, `/metrics`, `db/health` + `db/optimize`, backups & restore, rollback. |
| [ENV.md](./ENV.md) | Every environment variable: core runtime, auth/RBAC, metrics, storage, transcoding, and the Compose/installer `STREAMHUB_*` set. |
| [OBSERVABILITY.md](./OBSERVABILITY.md) | Prometheus (`/metrics` + LiveKit native), the exposed metric catalog, and Grafana (next). |
| [LATENCY-TUNING.md](./LATENCY-TUNING.md) | G1: mediciones reales de latencia por path (WebRTC 193ms p50 / HLS 15s / RTMP ~2s), harness `bench/latency/`, y la guía de palancas (buffers UDP, egress, playout delay, TURN). |

Related: [`../architecture/`](../architecture/README.md) for the service map and data model,
[`../config-reference.md`](../config-reference.md) for the per-app `config.yaml`,
[`../webhooks.md`](../webhooks.md) for the callback contracts.
