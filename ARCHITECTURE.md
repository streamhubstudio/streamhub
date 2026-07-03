# StreamHub — Architecture (overview)

StreamHub is a **management layer over a self-hosted [LiveKit](https://livekit.io) SFU** that
makes a plain LiveKit deployment behave like AntMedia: tenancy by **apps**, per-app S3
recording, its own REST API (global + per-app), embeddable players + a browser SDK, adaptive
transcoding, structured logs, snapshots, signed callbacks, RBAC + quotas and Prometheus
metrics — behind a **single domain** with automatic TLS.

This file is the top-level map. The **full, diagrammed architecture** lives in
[`streamhub-docs/architecture/`](./streamhub-docs/architecture/README.md); operations
runbooks live in [`streamhub-docs/operations/`](./streamhub-docs/operations/README.md).

> **Naming:** product = **StreamHub**; repo = `vision-media-server`.

## Single node (today)

```mermaid
flowchart TB
  subgraph Internet
    U[Browsers · OBS · ffmpeg · ESP32-CAM · SDK]
    S3[(App S3 · AWS/Wasabi/MinIO)]
  end
  U -->|443/80 https+wss| PX
  U -.->|WebRTC 7882/udp · RTMP 1935 · WHIP 8080| MEDIA
  subgraph HOST [Single node · public IP]
    PX[Reverse proxy<br/>Caddy auto-TLS · or nginx+certbot]
    PX -->|/rtc → 7880| LK
    PX -->|/ · /api/v1 · /hls · /sdk · /samples · /metrics → 3020| CORE
    CORE[streamhub-core · NestJS :3020<br/>REST API + React SPA + HLS + SDK<br/>SQLite · S3 jobs · callbacks · metrics]
    CORE -->|ws 7880| LK
    CORE --> DB[(streamhub.db + apps/&lt;app&gt;/app.db)]
    CORE -->|jobs 6379| RD[(redis)]
    CORE -->|upload/presign| S3
    subgraph MEDIA [LiveKit stack]
      LK[livekit-server · SFU<br/>7880/7881 tcp · 7882 udp]
      ING[ingress · RTMP 1935 · WHIP 8080] --> LK
      EG[egress · headless Chrome<br/>room-composite → MP4/HLS] --> LK
    end
    LK --> RD
    ING --> RD
    EG --> RD
    EG --> DATA[/DATA_DIR<br/>recordings · hls · snapshots · samples/]
    CORE --> DATA
  end
  CORE -.->|HMAC callbacks| U
  LK -.->|webhooks| CORE
```

**Ports:** 80/443 (proxy), 7880/7881 tcp + 7882 udp (LiveKit media), 1935 (RTMP), 8080
(WHIP), 3478 udp (embedded TURN, optional), 3020 (core, local), 6379 (redis, local).

**Processes:** `livekit`, `ingress`, `egress`, `redis`, `streamhub-core` (Node; serves API +
compiled React SPA + HLS + SDK + samples + `/metrics` — the old Laravel UI was removed). Two
deploy shapes: **Docker Compose + Caddy** (default) or **systemd + nginx + certbot**
(plain-server). Details → [architecture/services.md](./streamhub-docs/architecture/services.md).

## Data — per-app SQLite

A **minimal global** `data/streamhub.db` (tenants, users, memberships, quotas, api_tokens,
`nodes` cluster registry, `apps` pointer, server_logs) + **one `apps/<app>/app.db` per app**
owning all app-scoped state (streams, vods, ingress_auth). The global→per-app **split
migration** runs idempotently at boot after a `VACUUM INTO` backup of the global DB. Full ERD
+ flow → [architecture/data-model.md](./streamhub-docs/architecture/data-model.md).

## Target cluster (origin + edge)

Single-node today; designed for an **origin (master) + edge** cluster: a `nodes` registry +
**join by cluster-token + IP**, WebRTC **session affinity** (LiveKit pins a room to one node
via shared redis), a control-plane **router**, and pooled ingress/egress workers.
**Reality check:** WebRTC does not scale to 100k+ viewers — the design pairs **origin WebRTC
(interactive)** with **LL-HLS + CDN (mass audience)**. Full design →
[architecture/cluster.md](./streamhub-docs/architecture/cluster.md).

## Observability

streamhub-core exposes Prometheus at `/metrics` (root path; optional `METRICS_TOKEN`);
LiveKit exposes its own native metrics (`prometheus_port`). Prometheus scrapes both, Grafana
on top. Catalog + setup →
[operations/OBSERVABILITY.md](./streamhub-docs/operations/OBSERVABILITY.md).

## See also

- Operations: [DEPLOY](./streamhub-docs/operations/DEPLOY.md) ·
  [RUNBOOK](./streamhub-docs/operations/RUNBOOK.md) ·
  [ENV](./streamhub-docs/operations/ENV.md)
- API & config: [`streamhub-docs/`](./streamhub-docs/README.md)
