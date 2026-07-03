# StreamHub API — Endpoint Reference

Complete list of `streamhub-core` HTTP endpoints.

- **Base URL:** `https://streamhub.example.com/api/v1`
- **Prefix:** every REST endpoint is under `/api/v1` **except** `/metrics` and
  the static mounts (`/hls`, `/samples`, `/sdk`, `/play`, `/embed`, `/assets`).
- **Auth:** `Authorization: Bearer <credential>` — an `sk_...` API token or a
  login JWT. "public" rows need no auth.
- **Envelope:** most endpoints return `{ "data": <payload>, "error": null }`.
  Errors return the proper HTTP status + a NestJS error body.
- **AuthZ:** the "Permission" column is the Casbin `resource:action` the route
  requires; enforcement is phased by `STREAMHUB_AUTHZ_ENFORCE` (off/log/on).
  Superadmin and global api_tokens bypass tenant scoping.
- **Docs:** Swagger UI `/api/v1/docs`, OpenAPI JSON `/api/v1/openapi.json`.

`{app}` = app slug. `{id}` = resource id (stream ids contain `/`, URL-encode as `%2F`).

## Auth & teams

| Method | Path | Auth / Permission | Feature |
|--------|------|-------------------|---------|
| GET | `/auth/config` | public | [auth](../features/auth.md) — `{ allowSignup }` |
| POST | `/auth/signup` | public (gated by `STREAMHUB_ALLOW_SIGNUP`) | [auth](../features/auth.md) |
| POST | `/auth/login` | public | auth (2FA: send `code` when enabled) |
| POST | `/auth/magic-link` | public | auth (429 + `retryAfterSeconds` under the 60s resend cooldown) |
| POST | `/auth/magic/verify` | public | auth (2FA: send `code` when enabled) |
| POST | `/auth/reset-request` | public | auth |
| POST | `/auth/reset` | public | auth |
| GET | `/auth/me` | Bearer | auth |
| GET | `/account` | Bearer (human JWT) | auth — my profile + tenant |
| PATCH | `/account` | Bearer (human JWT) | auth — update name/email |
| POST | `/account/password` | Bearer (human JWT) | auth — change password |
| POST | `/account/2fa/setup` | Bearer (human JWT) | auth — start TOTP enrolment |
| POST | `/account/2fa/enable` | Bearer (human JWT) | auth — activate 2FA |
| POST | `/account/2fa/disable` | Bearer (human JWT) | auth — disable 2FA |
| GET | `/teams/mine` | usage:read | auth |
| POST | `/teams/mine/members` | tenant:write (owner) | auth |
| GET | `/tenant/invites` | owner/superadmin | auth — pending invitations |
| POST | `/tenant/invites` | owner/superadmin | auth — invite by email |
| DELETE | `/tenant/invites/{userId}` | owner/superadmin | auth — revoke invitation |

## API tokens

| Method | Path | Permission | Feature |
|--------|------|-----------|---------|
| GET | `/tokens` | Bearer | [tokens](../features/tokens.md) |
| POST | `/tokens` | Bearer | tokens |
| DELETE | `/tokens/{id}` | Bearer | tokens |

## Apps (registry)

| Method | Path | Permission | Feature |
|--------|------|-----------|---------|
| GET | `/apps` | app:read | [apps](../features/apps-multitenant.md) |
| POST | `/apps` | app:create | apps |
| GET | `/apps/{app}` | app:read | apps |
| PATCH | `/apps/{app}` | config:write | apps (flat patch: display/recording/callbacks/features) |
| DELETE | `/apps/{app}?deleteVods` | app:delete | apps |

## App config: raw editor + reload

| Method | Path | Permission | Feature |
|--------|------|-----------|---------|
| GET | `/apps/{app}/config/raw` | config:read | [config-editor](../features/config-editor.md) |
| PUT | `/apps/{app}/config/raw` | config:write | config-editor |
| POST | `/apps/{app}/config/raw/validate` | config:read | config-editor (dry-run + diff) |
| GET | `/apps/{app}/config/backups` | config:read | config-editor |
| GET | `/apps/{app}/config/backups/{ts}` | config:read | config-editor |
| POST | `/apps/{app}/config/backups/{ts}/revert` | config:write | config-editor |
| POST | `/apps/{app}/reload` | config:write | config-editor |

## App config: transcoding view

| Method | Path | Permission | Feature |
|--------|------|-----------|---------|
| GET | `/apps/{app}/config` | config:read | [transcoding-gpu](../features/transcoding-gpu.md) |
| PATCH | `/apps/{app}/config` | config:write | transcoding-gpu (adaptive/layers/rtmpTranscode/hwaccel/features) |
| GET | `/apps/{app}/transcoding/layers` | config:read | transcoding-gpu |

## App S3

| Method | Path | Permission | Feature |
|--------|------|-----------|---------|
| GET | `/apps/{app}/s3` | s3:read | [vod](../features/vod.md) |
| PUT | `/apps/{app}/s3` | s3:write | vod (public_url gated by confirmPublic) |

## Tokens (LiveKit join) & radio

| Method | Path | Permission | Feature |
|--------|------|-----------|---------|
| POST | `/apps/{app}/tokens` | stream:write | [tokens](../features/tokens.md) (hidden/recorder/audioOnly) |
| GET | `/apps/{app}/play-token/{room}` | public | [tokens](../features/tokens.md) — subscribe-only video+audio viewer token for `/play` + `/embed` (gated by `features.publicPlayback`) |
| GET | `/apps/{app}/radio/{room}/listen-token` | public | [radio-audio](../features/radio-audio.md) |

## Ingress (RTMP / WHIP / RTSP-relay)

| Method | Path | Permission | Feature |
|--------|------|-----------|---------|
| POST | `/apps/{app}/ingress` | ingress:create | [ingress](../features/ingress.md) |
| GET | `/apps/{app}/ingress?limit&offset&room&q` | ingress:read | ingress — paginated `{ data, total, limit, offset }` (limit 1..500, default 50). Each row: `room`, `status` (inactive/buffering/publishing/error/complete), `bitrate`, `width`/`height`, `viewers` (approx., null = unknown), `requires_password`, plus the revealable ingest credentials `rtmp_url` + `stream_key` |
| GET | `/apps/{app}/ingress/{id}` | ingress:read | ingress |
| DELETE | `/apps/{app}/ingress/{id}` | ingress:delete | ingress |
| POST | `/apps/{app}/ingress/{id}/validate` | ingress:write | ingress (RTMP password) |

## WS ingest (ESP32/MJPEG directo — [ESP32-WS-INGEST](../integrations/ESP32-WS-INGEST.md))

| Method | Path | Permission | Feature |
|--------|------|-----------|---------|
| POST | `/apps/{app}/ws-ingest` | ingress:create | Mints a `wsk_` camera key for a room. Body `{ room, identity? }`. Returns `{ id (wsi_…), streamKey (wsk_…, plaintext once), room, identity, wsUrl, mjpegUrl, frameUrl, playerUrl, embedUrl }`. Quota `max_concurrent_streams` applies. |
| GET | `/apps/{app}/ws-ingest` | ingress:read | Keys + live state (`active` = camera connected now). Credentials ride along like the RTMP ingress listing. |
| DELETE | `/apps/{app}/ws-ingest/{id}` | ingress:delete | Revokes the key; a live camera connection is closed immediately. |
| GET | `/apps/{app}/ws-ingest/live/{room}` | public | Whether a `ws-mjpeg` camera is live in the room (+ `mjpegUrl`/`frameUrl`/`wsUrl`). Drives the MJPEG mode of `/play` + `/embed`. Gated by `features.publicPlayback` (404 when off). |

**Device plane (not REST):** `wss://<dominio>/ingest/ws?app=&room=` — auth `Authorization: Bearer wsk_…` (o `&key=`); 1 mensaje binario = 1 frame JPEG. **Playback sin transcode:** `GET /live/{app}/{room}/mjpeg` (multipart/x-mixed-replace, funciona en `<img>`), `GET /live/{app}/{room}/frame.jpg` (último frame) y `wss://…/live/ws?app=&room=` (viewer WS) — públicos salvo `publicPlayback: false` (entonces exigen `?token=` de play). Fuera del prefix `/api/v1`.

## Streams

| Method | Path | Permission | Feature |
|--------|------|-----------|---------|
| GET | `/apps/{app}/streams` | stream:read | [streams](../features/streams.md) |
| GET | `/apps/{app}/streams/{id}` | stream:read | streams (+ viewers) |
| DELETE | `/apps/{app}/streams/{id}` | stream:stop | streams (204) |
| POST | `/apps/{app}/snapshots` | stream:write | [recording](../features/recording.md) (on-demand snapshot) |
| POST | `/apps/{app}/streams/{id}/data` | stream:write | [chat/reactions](../features/chat-reactions-viewers.md) |

## Recording & VOD

| Method | Path | Permission | Feature |
|--------|------|-----------|---------|
| POST | `/apps/{app}/recording/start` | recording:start | [recording](../features/recording.md) |
| POST | `/apps/{app}/recording/{id}/stop` | recording:stop | recording |
| POST | `/apps/{app}/streams/{id}/record/start` | recording:start | recording (record-live) |
| POST | `/apps/{app}/streams/{id}/record/stop` | recording:stop | recording |
| GET | `/apps/{app}/vods?limit&offset` | vod:read | [vod](../features/vod.md) |
| GET | `/apps/{app}/vods/{id}` | vod:read | vod (url/presignedUrl/publicUrl) |
| POST | `/apps/{app}/vods/{id}/probe` | vod:write | vod — ffprobe backfill of `duration_s`/`width`/`height`/`format` for legacy VODs (local file or presigned S3 source; best-effort, returns `{ ...vod, probed }`) |
| DELETE | `/apps/{app}/vods/{id}` | vod:delete | vod (DB+S3+local cascade) |

## HLS live

| Method | Path | Auth | Feature |
|--------|------|------|---------|
| POST | `/apps/{app}/streams/{id}/hls/start` | Bearer | [hls-live](../features/hls-live.md) |
| POST | `/apps/{app}/streams/{id}/hls/stop` | Bearer | hls-live |
| GET | `/apps/{app}/streams/{id}/hls` | Bearer | hls-live |

## Broadcast (external RTMP)

| Method | Path | Permission | Feature |
|--------|------|-----------|---------|
| POST | `/apps/{app}/broadcast/start` | broadcast:start | [broadcast](../features/broadcast.md) |
| POST | `/apps/{app}/broadcast/{id}/stop` | broadcast:stop | broadcast |
| GET | `/apps/{app}/broadcast` | broadcast:read | broadcast |

## Restream (reenvío multi-destino)

| Method | Path | Permission | Feature |
|--------|------|-----------|---------|
| POST | `/apps/{app}/streams/{id}/restream` | broadcast:start | [restream](../features/restream.md) |
| GET | `/apps/{app}/streams/{id}/restream` | broadcast:read | restream |
| DELETE | `/apps/{app}/streams/{id}/restream/{egressId}` | broadcast:stop | restream |

## Samples

| Method | Path | Permission | Feature |
|--------|------|-----------|---------|
| GET | `/apps/{app}/samples` | sample:read | [samples](../features/samples.md) |
| GET | `/apps/{app}/samples/{file}` | sample:read | samples |
| PUT | `/apps/{app}/samples/{file}` | sample:write | samples |
| POST | `/apps/{app}/samples/regenerate` | sample:write | samples |

## DB maintenance

| Method | Path | Permission | Feature |
|--------|------|-----------|---------|
| GET | `/apps/{app}/db/health` | usage:read | [db-maintenance](../features/db-maintenance.md) |
| POST | `/apps/{app}/db/optimize` | app:write | db-maintenance |
| POST | `/apps/{app}/db/purge` | app:delete | db-maintenance (confirm:true) |
| GET | `/system/db/health` | usage:read (global scope) | db-maintenance |

## Quotas

| Method | Path | Permission | Feature |
|--------|------|-----------|---------|
| GET | `/tenants/{id}/usage` | usage:read (own tenant) | [quotas](../features/quotas.md) |

## System / GPU

| Method | Path | Auth | Feature |
|--------|------|------|---------|
| GET | `/system/gpu?refresh` | Bearer | [transcoding-gpu](../features/transcoding-gpu.md) |
| POST | `/system/gpu/refresh` | Bearer | transcoding-gpu |

## Admin

| Method | Path | Auth | Feature |
|--------|------|------|---------|
| POST | `/admin/restart` | global-scope token | [config-editor](../features/config-editor.md) |

## Observability & health

| Method | Path | Auth | Feature |
|--------|------|------|---------|
| GET | `/health` | public | [observability](../features/observability.md) |
| GET | `/stats` | Bearer | observability |
| GET | `/logs` | Bearer | observability |
| GET | `/metrics` *(root, not /api/v1)* | public (+ optional METRICS_TOKEN) | observability |
| GET | `/docs` , `/openapi.json` | public | Swagger / OpenAPI |

## Internal (LiveKit webhook sink)

| Method | Path | Auth | Feature |
|--------|------|------|---------|
| POST | `/webhooks/livekit` | LiveKit signature (not Bearer) | [callbacks](../features/callbacks.md) |

## Public static mounts (no /api/v1 prefix, no auth)

| Path | Serves |
|------|--------|
| `/hls/{app}/{room}/index.m3u8` (+ `.ts`) | live HLS playlist/segments |
| `/samples/{app}/{file}` | per-app sample pages (CSP-sandboxed) |
| `/sdk/streamhub-adaptor.global.js` | the streamhub-adaptor browser SDK |
| `/play/{app}/{room}` , `/embed/{app}/{room}` | public player / embed pages (SPA) |
| `/assets/*` | SPA assets |

## Environment variables (core)

`PORT` (3020) · `HOST` (127.0.0.1) · `LIVEKIT_URL` (ws://127.0.0.1:7880) ·
`LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` · `PUBLIC_WS_URL` (wss://media…) ·
`RTMP_PUBLIC_HOST` · `PUBLIC_BASE_URL` · `REDIS_URL` · `STREAMHUB_JWT_SECRET` ·
`ADMIN_USER` / `ADMIN_PASS` · `STREAMHUB_API_TOKEN` (sk_) ·
`STREAMHUB_AUTHZ_ENFORCE` (off|log|on) · `DATA_DIR` · `SDK_DIR` · `METRICS_TOKEN` ·
`SYSTEMD_UNIT` (streamhub-core) · `LOG_LEVEL` · `NODE_ENV`.
</content>
