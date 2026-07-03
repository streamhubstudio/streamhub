# StreamHub — Architecture

StreamHub is a **management layer over a self-hosted [LiveKit](https://livekit.io) SFU**
that makes a plain LiveKit deployment behave like AntMedia: tenancy by **apps**, per-app
S3 recording, its own REST API (global + per-app), embeddable players + a drop-in browser
SDK, adaptive transcoding, structured logs, on-demand snapshots, signed outbound callbacks,
RBAC + quotas and Prometheus metrics — all behind a **single domain** with automatic TLS.

Today it runs **single-node**. The design keeps a clean seam to a future **origin + edge
cluster** without rewrites. These docs describe both.

## Documents

| Doc | Scope |
|-----|-------|
| [services.md](./services.md) | Single-node service map: processes, ports, request routing, the mono-Node core (API + SPA + HLS + SDK), LiveKit/ingress/egress/redis, deploy shapes (Docker Compose + Caddy, or systemd + nginx). Mermaid. |
| [data-model.md](./data-model.md) | The **per-app SQLite** model: a minimal global `streamhub.db` (identity + cluster routing) plus `apps/<app>/app.db` owning all app-scoped state. Tables, the idempotent split migration, cluster rationale. Mermaid ERD + flow. |
| [cluster.md](./cluster.md) | **Target cluster**: origin (master) + edge nodes, node registry + token/IP join, WebRTC session affinity via shared redis, viewer/transcode load-balancing, and the **WebRTC-vs-HLS/CDN reality check** for mass audiences. Mermaid. |

For deploying/operating what's described here, see [`../operations/`](../operations/README.md).
For the REST surface see the `api-*.md` docs; for the runtime config file per app see
[`../config-reference.md`](../config-reference.md).

## Naming note

The **product** is **StreamHub**; the **repository** is `vision-media-server`.

## One-paragraph mental model

A browser, OBS, an ESP32-CAM or a native SDK **publishes** into a room of an app (WebRTC,
RTMP, WHIP, or an RTSP→RTMP relay). **LiveKit** is the SFU that fans media out.
**streamhub-core** (NestJS) is the brain: it mints tokens, drives ingress/egress via the
LiveKit server SDK, persists everything in SQLite (global + per-app), records rooms to MP4
and uploads them to the app's own S3 bucket as VODs, serves the React dashboard, the HLS
playlists, the embeddable sample pages and the browser SDK, emits Prometheus metrics and
fires HMAC-signed callbacks on every event. A single reverse proxy (Caddy or nginx) fronts
it all on one TLS domain; WebRTC UDP media and RTMP go straight to the server IP.
