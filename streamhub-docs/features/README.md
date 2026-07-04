# StreamHub — Feature Reference

StreamHub is a management layer over a self-hosted **LiveKit** server that makes
it behave like AntMedia: multi-tenant **Apps**, per-app recording to **S3**, a
public embeddable **player**, adaptive transcoding, HLS live, callbacks, radio,
an SDK, and observability.

Runtime: **mono-Node** — `streamhub-core` (NestJS, TypeScript) serves the REST
API under `/api/v1` **and** the React SPA. LiveKit + ingress/egress (Docker) +
redis sit underneath. Data lives in SQLite (a global `streamhub.db` registry +
one `vods.db`/`app.db` per app) and media in S3 per app.

- **API base:** `https://streamhub.example.com/api/v1`
- **Response envelope:** almost every endpoint returns `{ "data": <payload>, "error": null }`. Errors use the correct HTTP status and a NestJS error body.
- **Auth:** `Authorization: Bearer <credential>` where the credential is either an `sk_...` API token or a login JWT. Public routes (health, docs, player `/play` `/embed`, `/samples`, `/hls`, `/metrics`, LiveKit webhooks, radio listen-token) need no auth.

## Feature index

| Doc | What it covers |
|-----|----------------|
| [apps-multitenant.md](apps-multitenant.md) | Apps as tenants: CRUD, scaffolding, config.yaml, per-app SQLite/S3 |
| [auth.md](auth.md) | Built-in auth: signup/login, teams isolation, roles, superadmin, `me` |
| [tokens.md](tokens.md) | API tokens (`sk_`) + LiveKit join tokens / grants (hidden QC, audioOnly) |
| [quotas.md](quotas.md) | Per-tenant quotas + enforcement + usage report |
| [ingress.md](ingress.md) | RTMP / WHIP / RTSP-relay ingest, stream key + password |
| [recording.md](recording.md) | Egress recording → S3 → VOD, record-live, split, snapshots |
| [vod.md](vod.md) | VOD list/get/delete (DB + S3 + local cascade), URLs |
| [adaptive-vod.md](adaptive-vod.md) | Post-transcode: adaptive HLS VOD (master + renditions), `h264+vp8`, default passthrough |
| [hls-live.md](hls-live.md) | Live HLS egress + `/hls/<app>/<room>/index.m3u8` |
| [broadcast.md](broadcast.md) | Re-stream a room to an external RTMP target (YouTube/Twitch) |
| [restream.md](restream.md) | Restream multi-destino: forward a live stream to N RTMP targets at once |
| [players.md](players.md) | WebRTC LivePlayer, HLS video.js, VOD player, public `/play` + `/embed` |
| [callbacks.md](callbacks.md) | HMAC-signed outbound webhooks + event taxonomy |
| [mqtt.md](mqtt.md) | Per-app MQTT event publishing (topics, envelope, log forwarding) + high-latency alerts |
| [chat-reactions-viewers.md](chat-reactions-viewers.md) | Data-channel chat, animated reactions, viewer counter |
| [transcoding-gpu.md](transcoding-gpu.md) | Adaptive ladder, GPU detection, `hwaccel` auto/gpu/cpu |
| [db-maintenance.md](db-maintenance.md) | Per-app SQLite health / optimize / purge |
| [config-editor.md](config-editor.md) | Raw YAML editor, backups, dry-run, revert, reload, restart |
| [presets.md](presets.md) | Config presets: low-latency / high-quality-recording / mass-audience-HLS (deep-merge + hot-reload) |
| [plugins.md](plugins.md) | Plugin framework (auto-discovery, workers, live-data channel) + the 8 built-in plugins (cockpit, quality, radio, streaming, timestamp, watermark, yolo, deface) |
| [samples.md](samples.md) | Per-app sample pages (publish/play/HLS/radio) + G4 turnkey verticals (CCTV/live-shopping/1:1/radio/conference) |
| [radio-audio.md](radio-audio.md) | Audio-only rooms + radio master/listener + listen-token |
| [adaptor-sdk.md](adaptor-sdk.md) | `@streamhub/adaptor` drop-in AntMedia SDK |
| [observability.md](observability.md) | Prometheus `/metrics`, health, stats, logs |

Full endpoint table: [../api/README.md](../api/README.md).

## Data & filesystem layout

```
<DATA_DIR>/                       # DATA_DIR, e.g. /opt/streamhub or /data
  data/streamhub.db               # GLOBAL registry: apps, api_tokens, tenants, users, memberships, quotas, server_logs
  data/secrets.json               # S3 key/secret per app (chmod 600) — never in yaml
  apps/<app>/
    config.yaml                   # the app config (see apps-multitenant.md)
    config.yaml.bak.<ts>          # timestamped backups (config editor)
    vods.db                       # per-app: vods + streams
    recordings/                   # local MP4s (temp, before upload)
    snapshots/                    # local JPEG snapshots
    hls/<room>/index.m3u8 + .ts   # live HLS output
    samples/*.html                # generated sample pages
  sdk/streamhub-adaptor.global.js # SDK served at /sdk
```

## Roles quick reference

`owner` (full control in tenant) · `editor` (create/edit/operate apps & media, cannot delete the app or manage tenant/tokens) · `viewer` (read-only) · `superadmin` (global, bypasses RBAC) · `service` (api_token principal).
</content>
