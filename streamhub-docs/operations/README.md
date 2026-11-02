# StreamHub — Operations

Runbooks for deploying, running and observing StreamHub on a single node.

| Doc | Scope |
|-----|-------|
| [INSTALL.md](./INSTALL.md) | The app as one folder + one service: `/opt/streamhub` layout, the `streamhub` CLI, the managed systemd unit, day-0 install, day-1 upgrade (idempotent, migrated, backed-up, rollback), the versioning scheme + release pipeline + required CI variables. |
| [INSTALL-NODE.md](./INSTALL-NODE.md) | The hosted one-liner installer (`curl https://www.streamhub.studio/install.sh \| sudo bash`, Ubuntu 24.04/26.04 LTS x64, idempotent): day-0 origin install, day-1 `--join` edge nodes, hosting of the script. |
| [MANUAL-BUILD-INSTALL.md](./MANUAL-BUILD-INSTALL.md) | Build from source & manual install, step by step: prerequisites, the Go core + SPA + SDK → one core image (`deploy/Dockerfile` stages), the single `.env`, `docker compose up` + seed-token, verify health/Swagger, `DATA_DIR` layout, manual node join — then what the one-liner automates. |
| [CLUSTER-UPDATES.md](./CLUSTER-UPDATES.md) | Updating a deployment: how releases are published, upgrading the master (`streamhub upgrade`, `--version` pinning = rollback, `--force`), upgrading joined common/edge nodes (re-run the join, master-first order), verifying rejoin, and health-fail rollback. |
| [MARKETPLACE.md](./MARKETPLACE.md) | One-click images for DigitalOcean, Vultr, Hetzner and AWS: the Packer template over `install.sh --prepare-image` (no secrets baked), first boot via cloud-init user-data or an SSH-login prompt, the DO-style cleanup + image check, variables per provider and the DO/Vultr submission checklists. |
| [HELM.md](./HELM.md) | The Helm chart `deploy/helm/streamhub`: core StatefulSet + PVC, LiveKit/ingress/egress on host networking with dedicated media nodes, redis, generated Secret, Ingress for HTTP + `/rtc` — and its limits (one media pod per node, single core, egress pinned to the core's RWO volume). |
| [DEPLOY.md](./DEPLOY.md) | Build (Go core + web SPA; plain-server core bundle), configure (`.env`), deploy both shapes (Docker Compose + Caddy, or systemd + nginx + certbot). Idempotent DB migration with automatic backup. Copy the browser SDK to `/sdk`, (re)generate per-app samples. |
| [RUNBOOK.md](./RUNBOOK.md) | Day-2: start/restart, health checks, `/metrics`, `db/health` + `db/optimize`, backups & restore, rollback. |
| [ENV.md](./ENV.md) | Every environment variable: core runtime, auth/RBAC, metrics, storage, transcoding, and the Compose/installer `STREAMHUB_*` set. |
| [OBSERVABILITY.md](./OBSERVABILITY.md) | Prometheus (`/metrics` + LiveKit native), the exposed metric catalog, and Grafana (next). |
| [LATENCY-TUNING.md](./LATENCY-TUNING.md) | G1: mediciones reales de latencia por path (WebRTC 193ms p50 / HLS 15s / RTMP ~2s), harness `streamhub-core-go/test/bench/latency/`, y la guía de palancas (buffers UDP, egress, playout delay, TURN). |
| [OS-TUNING.md](./OS-TUNING.md) | The host kernel/limit knobs that matter for a LiveKit/WebRTC media server (UDP socket buffers, `somaxconn`, `udp_mem`, ephemeral port range, fd limits, swappiness, THP): what each is, why it matters, the recommended value + remedy, what `install.sh` already applies, and the read-only `GET /system/os-tuning` reporter + Server-settings panel that shows applied/not-applied per knob. |
| [SCALING.md](./SCALING.md) | Scaling HLS to tens of thousands of viewers: where the single-origin ceiling is (Node ~1.5k, Go ≥10k), the `STREAMHUB_HLS_DIRECT_SERVE` opt-in (Caddy/nginx serve `.ts`/`.m3u8` from disk), the cloud-free knee finder (`loadgen hls`, "fly mode") and edge fan-out. |

Related: [`../architecture/`](../architecture/README.md) for the service map and data model,
[`../config-reference.md`](../config-reference.md) for the per-app `config.yaml`,
[`../webhooks.md`](../webhooks.md) for the callback contracts.
