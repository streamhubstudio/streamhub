# StreamHub — Feature Reference

StreamHub is a management layer over a self-hosted **LiveKit** server that makes
it behave like AntMedia: multi-tenant **Apps**, per-app recording to **S3**, a
public embeddable **player**, adaptive transcoding, HLS live, callbacks, radio,
an SDK, and observability.

Runtime: **one Go binary** — `streamhub-core` (`streamhub-core-go/`) serves the REST
API under `/api/v1` **and** the React SPA. LiveKit + ingress/egress (Docker) +
redis sit underneath. Data lives in SQLite (a global `streamhub.db` registry +
one `vods.db`/`app.db` per app) and media in S3 per app.

- **API base:** `https://streamhub.digitalhub.com.ar/api/v1`
- **Response envelope:** almost every endpoint returns `{ "data": <payload>, "error": null }`. Errors use the correct HTTP status and a `{statusCode, message, error}` body (the 2.x NestJS shape, kept byte-for-byte).
- **Auth:** `Authorization: Bearer <credential>` where the credential is either an `sk_...` API token or a login JWT. Public routes (health, docs, player `/play` `/embed`, `/samples`, `/hls`, `/metrics`, LiveKit webhooks, radio listen-token) need no auth.

## Feature index

| Doc | What it covers |
|-----|----------------|
| [apps-multitenant.md](apps-multitenant.md) | Apps as tenants: CRUD, scaffolding, config.yaml, per-app SQLite/S3 |
| [pipeline-diagram.md](pipeline-diagram.md) | `GET /apps/:app/pipeline` — resolved media-pipeline topology + the animated dashboard flow diagram (`AppFlowDiagram`) |
| [auth.md](auth.md) | Built-in auth: signup/login, teams isolation, roles, superadmin, `me` |
| [tokens.md](tokens.md) | API tokens (`sk_`) + LiveKit join tokens / grants (hidden QC, audioOnly) |
| [quotas.md](quotas.md) | Per-tenant quotas + enforcement + usage report |
| [ingress.md](ingress.md) | RTMP / WHIP / RTSP-relay ingest, stream key + password, **primary + backup (failover) keys** |
| [recording.md](recording.md) | Egress recording → S3 → VOD, record-live, split, snapshots |
| [vod.md](vod.md) | VOD list/get/delete (DB + S3 + local cascade), URLs |
| [adaptive-vod.md](adaptive-vod.md) | Post-transcode: adaptive HLS VOD (master + renditions), `h264+vp8`, default passthrough |
| [DRM.md](DRM.md) | Encrypted VOD/HLS packaging (`features.drm`): CENC/CBCS CMAF via shaka-packager + external key server, default OFF |
| [hls-live.md](hls-live.md) | Live HLS egress + `/hls/<app>/<room>/index.m3u8` |
| [signed-hls.md](signed-hls.md) | 3.4.0 (G2): `?st=` token on `/hls` of private apps (playlist rewriting, direct-serve `auth_request`), `features.geo` geo-blocking (GeoLite2), `features.play_auth` webhook; AMS TOTP evaluated (pending) |
| [dvr-clips.md](dvr-clips.md) | DVR/timeshift (`features.dvr`, `dvr.m3u8`, seek + `?t=`), `hlsTime`/`hlsListSize`, clips instantáneos y por evento (`…/clips`, `action.clip`, `clip.ready`) |
| [HLS-CDN.md](HLS-CDN.md) | HLS edge/CDN cache headers (`.ts` immutable, `.m3u8` no-cache / `STREAMHUB_HLS_CDN` SWR) + ready-made nginx/Caddy edge configs |
| [ENDLESS-RADIO-STATUS.md](ENDLESS-RADIO-STATUS.md) | 24/7 linear-channel hardening (`features.linear.*`): persistent room, auto-HLS watchdog, broadcaster quota preset, bounded DVR manifest + segment janitor |
| [broadcast.md](broadcast.md) | Re-stream a room to an external RTMP target (YouTube/Twitch) |
| [restream.md](restream.md) | Restream multi-destino: forward a live stream to N RTMP targets at once |
| [players.md](players.md) | WebRTC LivePlayer, HLS video.js, VOD player, public `/play` + `/embed` |
| [callbacks.md](callbacks.md) | HMAC-signed outbound webhooks + event taxonomy |
| [mqtt.md](mqtt.md) | Per-app MQTT event publishing (topics, envelope, log forwarding) + high-latency alerts |
| [chat-reactions-viewers.md](chat-reactions-viewers.md) | Data-channel chat, animated reactions, viewer counter |
| [transcoding-gpu.md](transcoding-gpu.md) | Adaptive ladder, GPU detection, `hwaccel` auto/gpu/cpu |
| [GRID.md](GRID.md) | BYO-GPU worker offload — plugin/transcode workers dispatch to a remote GPU node (`placement: 'grid'`), local fallback |
| [vision-edge.md](vision-edge.md) | Computer-vision edge cluster: NAT-friendly outbound-WS edge nodes, scheduler (RR/weighted + VRAM cap + failover), watchdog + notifier fan-out, per-app net I/O, and the `vision` Studio App (occupancy/counting/crowd/demography) + `streamhub-vision-edge` runtime |
| [tags.md](tags.md) | Dynamic per-app stream/room TAGS with per-tag `config_json` + defaults→tags→stream settings merge (the vision suite's per-stream config layer) |
| [vision-sizing.md](vision-sizing.md) | Sizing & pricing: MEASURED per-model GPU capacity (Tesla T4), agent/master/edge limits, bandwidth, and approximate AWS/DigitalOcean/Azure monthly cost — the data behind the vision app's Sizing calculator |
| [db-maintenance.md](db-maintenance.md) | Per-app SQLite health / optimize / purge |
| [config-editor.md](config-editor.md) | Raw YAML editor, backups, dry-run, revert, reload, restart |
| [presets.md](presets.md) | Config presets: low-latency / high-quality-recording / mass-audience-HLS (deep-merge + hot-reload) |
| [plugins.md](plugins.md) | Plugin framework (auto-discovery, workers, live-data channel) + the 17 built-ins (10 Studio Apps + 7 plugins) |
| [STUDIO-APPS.md](STUDIO-APPS.md) | Studio-App taxonomy: `kind: 'plugin'` vs `'app'`, full-page App view, storage declaration, and the export-to-standalone bundle (worker tarball, off-host HLS, signed-webhook plane) |
| [samples.md](samples.md) | Per-app sample pages (publish/play/HLS/radio) + G4 turnkey verticals (CCTV/live-shopping/1:1/radio/conference) |
| [radio-audio.md](radio-audio.md) | Audio-only rooms + radio master/listener + listen-token |
| [adaptor-sdk.md](adaptor-sdk.md) | `@streamhub/adaptor` drop-in AntMedia SDK |
| [WEBRTC-BROWSER-COMPAT.md](WEBRTC-BROWSER-COMPAT.md) | Safari/iOS WebRTC risks (AntMedia bug-class analysis) + applied mitigations + TURN recommendation |
| [observability.md](observability.md) | Prometheus `/metrics`, health, stats, logs |
| [network-security.md](network-security.md) | In-app IP allow/blocklist + auto-ban abuse protection (global middleware before auth) |
| [publisher-restrictions.md](publisher-restrictions.md) | Per-app publisher network allowlist (`allowed_publisher_cidr`) + ingest bitrate cap (`max_bitrate_accept`) — AntMedia quick wins 3.4.0 |

Full endpoint table: [../api/README.md](../api/README.md).
Cluster-wide monitoring (Prometheus + Grafana + Loki/Promtail across nodes):
[../operations/CLUSTER-OBSERVABILITY.md](../operations/CLUSTER-OBSERVABILITY.md).

## Data & filesystem layout

```
<DATA_DIR>/                       # DATA_DIR, e.g. /home/ploi/streamhub or /data
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
