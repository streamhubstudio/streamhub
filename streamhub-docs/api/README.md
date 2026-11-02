# StreamHub API — Endpoint Reference

Complete list of `streamhub-core` HTTP endpoints.

- **Base URL:** `https://streamhub.digitalhub.com.ar/api/v1`
- **Prefix:** every REST endpoint is under `/api/v1` **except** `/metrics` and
  the static mounts (`/hls`, `/samples`, `/sdk`, `/play`, `/embed`, `/assets`).
- **Auth:** `Authorization: Bearer <credential>` — an `sk_...` API token or a
  login JWT. "public" rows need no auth.
- **Envelope:** most endpoints return `{ "data": <payload>, "error": null }`.
  Errors return the proper HTTP status + a `{statusCode, message, error}` body
  (the 2.x NestJS shape, kept byte-for-byte by the Go core).
- **AuthZ:** the "Permission" column is the Casbin `resource:action` the route
  requires; enforcement is phased by `STREAMHUB_AUTHZ_ENFORCE` (off/log/on).
  Superadmin and global api_tokens bypass tenant scoping.
- **Docs:** Swagger UI `/api/v1/docs`, OpenAPI JSON `/api/v1/openapi.json`.

`{app}` = app slug. `{id}` = resource id (stream ids contain `/`, URL-encode as `%2F`).

## Auth & teams

| Method | Path | Auth / Permission | Feature |
|--------|------|-------------------|---------|
| GET | `/auth/config` | public | [auth](../features/auth.md) — `{ allowSignup, nodeRole, masterUrl, loginEnabled, appVersion, samplesUrl? }` (`samplesUrl` only with `STREAMHUB_SAMPLES_URL`) |
| POST | `/auth/signup` | public (gated by `STREAMHUB_ALLOW_SIGNUP`) | [auth](../features/auth.md) |
| POST | `/auth/login` | public | auth (2FA: send `code` when enabled); brute-force throttle per IP + per account → 429 + `Retry-After` (also on `/auth/magic/verify`, `/account/2fa/*`) |
| POST | `/auth/magic-link` | public | auth (429 + `retryAfterSeconds` under the 60s resend cooldown) |
| POST | `/auth/magic/verify` | public | auth (2FA: send `code` when enabled); also confirms an email change |
| GET | `/auth/me` | Bearer | auth |
| GET | `/account` | Bearer (human JWT) | auth — my profile + tenant |
| PATCH | `/account` | Bearer (human JWT) | auth — update name; email change in two steps (`pendingEmail`, confirmed via `/auth/magic/verify`) |
| POST | `/account/password` | Bearer (human JWT) | auth — change password (revokes every OTHER session of mine) |
| POST | `/account/2fa/setup` | Bearer (human JWT) | auth — start TOTP enrolment |
| POST | `/account/2fa/enable` | Bearer (human JWT) | auth — activate 2FA |
| POST | `/account/2fa/disable` | Bearer (human JWT) | auth — disable 2FA |
| GET | `/account/smtp` | Bearer (human JWT) | [smtp](../features/smtp.md) — my SMTP override (password masked) |
| PUT | `/account/smtp` | Bearer (human JWT) | smtp — update (password encrypted at rest; omit to keep) |
| POST | `/account/smtp/test` | Bearer (human JWT) | smtp — send a probe email via my SMTP (bypasses `enabled`); failures are fixed codes (`smtp_not_configured`, `smtp_host_not_allowed`, `smtp_send_failed`), detail only in the server log |
| GET | `/account/tenants` | Bearer (human JWT) | auth — teams I'm an active member of (`current` = this session's) |
| POST | `/account/tenants/{tenantId}/switch` | Bearer (human JWT) | auth — work in another of my teams (pinned on this session; 404 if not an active member) |
| GET | `/account/invitations` | Bearer (human JWT) | auth — team invitations waiting for my answer (3.3.4) |
| POST | `/account/invitations/{tenantId}/accept` | Bearer (human JWT) | auth — accept one (the session's team doesn't change) |
| POST | `/account/invitations/{tenantId}/decline` | Bearer (human JWT) | auth — decline one |
| GET | `/auth/sessions` | Bearer (human JWT) | auth — my active sessions (ip, dates, `current`) |
| DELETE | `/auth/sessions/{id}` | Bearer (human JWT) | auth — revoke one session (current = sign out) |
| DELETE | `/auth/sessions` | Bearer (human JWT) | auth — revoke every OTHER session |
| GET | `/teams/mine` | usage:read | auth |
| POST | `/teams/mine/members` | tenant:write (owner) | auth — an existing account gets a pending membership |
| GET | `/tenant/invites` | owner/superadmin | auth — pending invitations (pending users + pending memberships) |
| POST | `/tenant/invites` | owner/superadmin | auth — invite by email (existing account: pending membership, mail to "Mi cuenta", no link) |
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
| GET | `/apps/{app}/pipeline` | app:read | apps — resolved media-pipeline topology (ingest → processing → delivery → storage + plugins + live hints) for the dashboard flow diagram. Config.yaml is the source of truth; `active` flags come from the per-app `streams` table + on-disk HLS playlists (no LiveKit round-trips). Never returns credentials (bucket / public base names only) |
| PATCH | `/apps/{app}` | config:write | apps (flat patch: display/recording/callbacks/features/[timezone](../features/timezone.md); `features.allowedPublisherCidr` / `features.maxBitrateAccept` since 3.4.0 — [publisher-restrictions](../features/publisher-restrictions.md)) |
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

## App config: presets

| Method | Path | Permission | Feature |
|--------|------|-----------|---------|
| GET | `/apps/{app}/presets` | config:read | [presets](../features/presets.md) — each entry flags `applied` |
| POST | `/apps/{app}/presets/{name}/apply` | config:write | presets — deep-merge + backup + hot-reload |
| POST | `/apps/{app}/presets/{name}/deactivate` | config:write | presets — reverts the preset's keys to factory defaults (or removes forward-looking keys with no default) + backup + hot-reload |

## App config: transcoding view

| Method | Path | Permission | Feature |
|--------|------|-----------|---------|
| GET | `/apps/{app}/config` | config:read | [transcoding-gpu](../features/transcoding-gpu.md) |
| PATCH | `/apps/{app}/config` | config:write | transcoding-gpu (adaptive/layers/rtmpTranscode/hwaccel/features; `features.allowedPublisherCidr` / `features.maxBitrateAccept` since 3.4.0 — [publisher-restrictions](../features/publisher-restrictions.md)) |
| GET | `/apps/{app}/transcoding/layers` | config:read | transcoding-gpu |

## App S3

| Method | Path | Permission | Feature |
|--------|------|-----------|---------|
| GET | `/apps/{app}/s3` | s3:read | [vod](../features/vod.md) |
| PUT | `/apps/{app}/s3` | s3:write | vod (public_url gated by confirmPublic; setting `provider:"aws"` without an explicit `endpoint` auto-clears a stale scaffold endpoint; optional `storageClass` since 3.4.0 — one of the known S3 classes or `""` to clear, else 400 — see [config-reference.md](../config-reference.md#s3)) |

## App MQTT

| Method | Path | Permission | Feature |
|--------|------|-----------|---------|
| GET | `/apps/{app}/mqtt` | config:read | [mqtt](../features/mqtt.md) (password masked) |
| PUT | `/apps/{app}/mqtt` | config:write | mqtt (password → secrets.json; omit to keep) |

## App SMTP

| Method | Path | Permission | Feature |
|--------|------|-----------|---------|
| GET | `/apps/{app}/smtp` | config:read | [smtp](../features/smtp.md) (password masked) |
| PUT | `/apps/{app}/smtp` | config:write | smtp (password → secrets.json; omit to keep) |
| POST | `/apps/{app}/smtp/test` | config:write | smtp — send a probe email via this app's SMTP (bypasses `enabled`); same fixed error codes as `/account/smtp/test` |

## Plugins

| Method | Path | Permission | Feature |
|--------|------|-----------|---------|
| GET | `/apps/{app}/plugins` | plugin:read | [plugins](../features/plugins.md) — marketplace: every built-in plugin + this app's install/config state. Optional `?stream=`/`?room=` makes it STREAM-AWARE (a plugin the stream/room opted out of comes back `enabled:false`); no scope = app-level list unchanged |
| GET | `/apps/{app}/plugins/{id}` | plugin:read | plugins — one marketplace entry |
| GET | `/apps/{app}/plugins/{id}/export` | plugin:write | plugins → [Studio Apps](../features/STUDIO-APPS.md) — export an installed, `exportable` Studio App as a standalone `application/gzip` tarball (`streamhub-app-<id>-<version>.tar.gz`: worker source + generated Dockerfile/compose/.env.example/README, placeholders only). 404 unknown plugin, 400 not-exportable or not-installed, 503 worker source unavailable |
| POST | `/apps/{app}/plugins/{id}/install` | plugin:write | plugins — install into the app (idempotent) |
| PATCH | `/apps/{app}/plugins/{id}` | plugin:write | plugins — enable/disable and/or reconfigure (`config` validated against schema) |
| DELETE | `/apps/{app}/plugins/{id}` | plugin:write | plugins — uninstall (stops its worker, clears live-data feeds) |
| GET | `/apps/{app}/plugins/{id}/logs` | plugin:read | plugins — per-plugin logs |
| POST | `/apps/{app}/plugins/{id}/worker/start` | plugin:write | plugins — start worker (`needsWorker` plugins) |
| POST | `/apps/{app}/plugins/{id}/worker/stop` | plugin:write | plugins — stop worker |
| GET | `/apps/{app}/plugins/{id}/worker/status` | plugin:read | plugins — worker state |
| POST | `/apps/{app}/plugins/{id}/live` | `X-Plugin-Ingest-Token` (not Bearer) | plugins — worker-only live-data push |
| POST | `/apps/{app}/plugins/{id}/events` | `X-Plugin-Ingest-Token` (not Bearer) | plugins — worker-only DOMAIN-EVENT push `{event, room?, data?}`; only names the plugin manifest declares in `events` are accepted, then relayed through the app's signed callbacks (+ MQTT) — e.g. `lpr` emits `plate.detected`/`plate.allowed`/`plate.denied` |
| GET | `/apps/{app}/plugins/{id}/data?room` | plugin:read | plugins — latest live-data payload for ANY installed plugin (authenticated app-tab/panel read, e.g. the LPR recent-reads ring) |
| GET | `/apps/{app}/plugins/{id}/live?room` | public | plugins — latest live-data payload for an enabled `player-overlay` plugin |
| GET | `/apps/{app}/plugins/{id}/live/state?room` | plugin:read | plugins — AUTHENTICATED latest live-data payload for any installed+enabled `needsWorker` plugin regardless of UI slot — the dashboard counterpart for app-tab/panel workers whose feed must not be public (e.g. the `perimeter` armed state + alert queue) |
| GET | `/apps/{app}/plugins/public` | public | plugins — enabled `player-overlay` plugins, config sanitized, for anonymous `/play`/`/embed`. Optional `?stream=`/`?room=` subtracts that stream's opted-out overlays (per-stream plugin opt-out) |

## Vision Studio App (computer-vision edge)

Per-app surface of the `vision` Studio App — [vision-edge.md](../features/vision-edge.md). The worker-only `events` push uses the generic plugin route (`POST /apps/{app}/plugins/vision/events`, `X-Plugin-Ingest-Token`) above.

| Method | Path | Permission | Feature |
|--------|------|-----------|---------|
| GET | `/apps/{app}/plugins/vision/overview` | config:read | per-model counts today + assignments + nodes |
| GET | `/apps/{app}/plugins/vision/streams` | config:read | active rooms with their tags + per-model settings state |
| GET | `/apps/{app}/plugins/vision/streams/{room}/settings/{model}` | config:read | a room×model settings override + its resolved config (`model` = occupancy\|counting\|crowd\|demography) |
| PUT | `/apps/{app}/plugins/vision/streams/{room}/settings/{model}` | config:write | set a room×model override (polygons/lines/roi); validated + normalized (`400` on bad shape/unknown model), re-pushed to any matching edge assignment |
| GET | `/apps/{app}/plugins/vision/events?model&limit` | config:read | recent detections for a model from `vision.db` (limit default 50, max 1000) |
| GET | `/apps/{app}/plugins/vision/nodes` | config:read | edge-nodes view (liveness + storage/GPU) for this app surface |
| GET | `/apps/{app}/plugins/vision/assignments` | config:read | this app's vision edge assignments |
| POST | `/apps/{app}/plugins/vision/assignments` | config:write | schedule `{room, model, policy?}` (forces `pluginId=vision`; parked pending when no node is eligible) |
| DELETE | `/apps/{app}/plugins/vision/assignments/{id}` | config:write | revoke a vision assignment |

## Stream Health Studio App (origin quality monitor)

Per-app surface of the `stream-health` Studio App — [stream-health.md](../features/stream-health.md). The worker-only `events`/`live` pushes use the generic plugin routes (`POST /apps/{app}/plugins/stream-health/events` + `/live`, `X-Plugin-Ingest-Token`) above; the tab reads the live overview via the generic `GET /apps/{app}/plugins/stream-health/live/state?room=overview`.

| Method | Path | Permission | Feature |
|--------|------|-----------|---------|
| GET | `/apps/{app}/plugins/stream-health/overview` | config:read | health events today + rooms with recent history / threshold overrides |
| GET | `/apps/{app}/plugins/stream-health/events?limit&room` | config:read | recent `health.*` transitions from `stream-health.db` (limit default 50, max 1000; optional room scope) |
| GET | `/apps/{app}/plugins/stream-health/streams/{room}/settings` | config:read | a room's threshold override + the resolved effective thresholds (defaults ⊕ install config ⊕ override) |
| PUT | `/apps/{app}/plugins/stream-health/streams/{room}/settings` | config:write | set a PARTIAL per-room override. Body **`{"config":{…thresholds}}`** — e.g. `{"config":{"silence_db":-60}}`; `400` unknown threshold / out-of-range, and (3.4) `400` for any other top-level key (an unwrapped `{"silence_db":-60}`) or a non-object body; empty body / `{}` / `{"config":{}}` clear it; picked up live by the worker, no restart |

## Cameras Studio App (OpenCam console)

Per-app surface of the in-core `cameras` Studio App — [cameras.md](../features/cameras.md). OpenCam cameras over the app's MQTT broker (contract `opencameras/docs/STREAMHUB.md`, `api: 1`). Command routes answer `201` with the command row (`status` `pending|accepted|progress|done|failed|timeout`, or `sent` for the non-persisted PTZ repeat); every POST accepts `waitMs` (≤ 20000) to block until it settles. `404` unknown camera · `409` app inactive (not enabled / no `mqtt`) or the camera's `hello.caps` lacks the capability · `400` validation / dangerous command without `confirm`.

| Method | Path | Permission | Feature |
|--------|------|-----------|---------|
| GET | `/apps/{app}/plugins/cameras/cameras?site&stand&tag&online` | config:read | inventory + last hello/state summary, `active`, `baseTopic` |
| POST | `/apps/{app}/plugins/cameras/cameras` | config:write | alta `{device, name?, site?, stand?, model?, room?, streamUrl?, streamKey?, tags?, mqttUser?, mqttPass?}` → `201` (mints `cam-<device>` + password); `409` already provisioned |
| GET | `/apps/{app}/plugins/cameras/cameras/{device}` | config:read | camera + state history + 20 recent commands + 50 events |
| PATCH | `/apps/{app}/plugins/cameras/cameras/{device}` | config:write | edit inventory fields |
| DELETE | `/apps/{app}/plugins/cameras/cameras/{device}` | config:write | forget the camera (history, commands, events) |
| GET | `/apps/{app}/plugins/cameras/cameras/{device}/config.ini` | config:write | provisioning `config.ini` (carries the camera's broker password) |
| GET | `/apps/{app}/plugins/cameras/cameras/{device}/thumb` | config:read | retained thumbnail JPEG (`404` none) |
| GET | `/apps/{app}/plugins/cameras/cameras/{device}/events?level&src&before&limit` | config:read | event log, newest first (cursor `before` = id) |
| POST | `/apps/{app}/plugins/cameras/cameras/{device}/command` | config:write | any allowlisted command `{cmd, args?, exp?, ifRev?, confirm?, waitMs?}`; dangerous ones need `confirm:true` and are audited |
| GET | `/apps/{app}/plugins/cameras/cameras/{device}/commands/{id}` | config:read | one command + phase / pct / code |
| POST | `/apps/{app}/plugins/cameras/cameras/{device}/ptz/move` | config:write | `ptz/dir {dir, speed?, step?, holdMs=500}` — deadman repeat, not stored |
| POST | `/apps/{app}/plugins/cameras/cameras/{device}/ptz/stop` · `/ptz/home` | config:write | PTZ stop · home |
| POST | `/apps/{app}/plugins/cameras/cameras/{device}/ptz/preset` | config:write | go to preset `{preset}` |
| POST | `/apps/{app}/plugins/cameras/cameras/{device}/stream/start` · `/stream/stop` | config:write | RTMP push on/off |
| POST | `/apps/{app}/plugins/cameras/cameras/{device}/stream/hd` | config:write | `{on, minutes?}` main stream for N min (`stream/set {source:0}`, auto-revert) → `{command, hdUntil}` |
| POST | `/apps/{app}/plugins/cameras/cameras/{device}/snapshot` | config:write | `snapshot/take` |
| POST | `/apps/{app}/plugins/cameras/cameras/{device}/voice/test` | config:write | `voice/say {key=network_offline}` |
| POST | `/apps/{app}/plugins/cameras/cameras/{device}/reboot` | config:write | `system/reboot {reason}`; `done` when the camera reconnects with a new `boot_id`; audited |

## Tags (dynamic stream tagging)

Per-app tag entities + stream/room application — [tags.md](../features/tags.md).

| Method | Path | Permission | Feature |
|--------|------|-----------|---------|
| GET | `/apps/{app}/tags?kind` | config:read | list tags (optional `kind` filter) |
| POST | `/apps/{app}/tags` | config:write | create `{slug, label, kind?, config_json?}` (`409` dup slug, `400` bad slug) |
| GET | `/apps/{app}/tags/{slug}` | config:read | one tag (`404` if absent) |
| PATCH | `/apps/{app}/tags/{slug}` | config:write | update `label`/`kind`/`config_json` (slug immutable) |
| DELETE | `/apps/{app}/tags/{slug}` | config:write | delete + prune the slug from every stream (`204`) |
| PATCH | `/apps/{app}/tags/room/{room}` | stream:write | apply tag slugs to every stream row of a room → `{room, tags, updated}` |
| GET | `/apps/{app}/streams/{id}/tags` | stream:read | a stream's applied tag slugs |
| PATCH | `/apps/{app}/streams/{id}/tags` | stream:write | replace a stream's applied tags (every slug must exist, `400` otherwise) |

## Network I/O (per-app bytes)

Per-app media-plane byte accounting + threshold posture — [vision-edge.md](../features/vision-edge.md#per-app-network-io--threshold).

| Method | Path | Permission | Feature |
|--------|------|-----------|---------|
| GET | `/apps/{app}/net` | usage:read | rolling summary (today / 24h / 7d, per direction + source) + configured threshold posture |
| GET | `/apps/{app}/net/history?hours` | usage:read | hourly-bucketed in/out rows for the dashboard sparkline (`hours` default 48, clamped 1–720) |

## Tokens (LiveKit join) & radio

| Method | Path | Permission | Feature |
|--------|------|-----------|---------|
| POST | `/apps/{app}/tokens` | stream:write | [tokens](../features/tokens.md) (hidden/recorder/audioOnly; a publish-capable token from outside `features.allowed_publisher_cidr` → 403 since 3.4.0 — [publisher-restrictions](../features/publisher-restrictions.md)) |
| GET | `/apps/{app}/play-token/{room}` | public | [tokens](../features/tokens.md) — subscribe-only video+audio viewer token for `/play` + `/embed`. Apps with `features.publicPlayback: false` require a signed URL (`?exp=&sig=`, P0-3) minted by the sign endpoint below |
| POST | `/apps/{app}/play-token/{room}/sign` | stream:read | signed short-TTL playback URL (HMAC per app+room, default 300 s, 30 s–24 h) for private-playback apps. For a private app it also returns `hlsToken` / `hlsExp` / `hlsUrl` (the `?st=` its `/hls` needs, [signed-hls](../features/signed-hls.md)) |
| GET | `/apps/{app}/hls-token/{room}` | public | [signed-hls](../features/signed-hls.md) (3.4.0) — the `?st=` HLS token of a private app's room (`{required, st, exp, ttlSeconds, playlistUrl}`); same gate as `play-token` (signed URL, geo, play-auth). Public apps answer `required:false`, `st:""` |
| GET | `/apps/{app}/radio/{room}/listen-token` | public | [radio-audio](../features/radio-audio.md) — same signed-URL gate as `play-token` when `publicPlayback: false` |

## Ingress (RTMP / WHIP / RTSP-relay)

| Method | Path | Permission | Feature |
|--------|------|-----------|---------|
| POST | `/apps/{app}/ingress` | ingress:create | [ingress](../features/ingress.md) — `inputType: rtmp\|whip\|url\|srt\|mpegts`. `url` (pull) trae un RTSP/HLS/MP4/SRT remoto a la sala (`IngressInput.URL_INPUT`); la URL pasa un guard anti-SSRF (schemes http/https/rtsp/rtsps/rtmp/rtmps/srt; hosts que son/resuelven a rangos privados/loopback/link-local/metadata → 400; soporte srt:// del URL ingress depende de la versión del ingress de LiveKit — un server sin srtsrc rechaza el create y el error sale por la vía normal). `srt` (push) es SOLO passthrough: requiere `mode:'passthrough'` (la API de ingress de LiveKit no tiene input SRT); devuelve `srt_url: srt://host:puerto?streamid=<key>` + `hls_url` + `capabilities` (con `latencyMs` ~120ms) — ver [rtmp-passthrough](../features/rtmp-passthrough.md). `mpegts` (MPEG-TS sobre UDP unicast/multicast) es SOLO passthrough y un **PULL**: requiere `mode:'passthrough'` + `url:'udp://@GRUPO:PUERTO'` (campos opcionales `sources` para SSM/IGMPv3, `localaddr` para elegir NIC, `fifoSize`, `overrunNonfatal`). El backend valida el grupo multicast (224.0.0.0/4) + puerto y canoniza la URL udp:// (rechaza params no soportados → 400); devuelve `source_url` (la fuente udp:// que remuxea, sin push URL ni key) + `hls_url` + `capabilities` — ver [mpegts-multicast](../features/mpegts-multicast.md). RTMP con `backup:true` → **primary + backup (failover) stream keys**: dos ingresses en la MISMA sala (misma URL de player); la respuesta agrega `primaryStreamKey`/`backupStreamKey` + `backup_rtmp_url`/`backup_rtmps_url` + `role:'primary'`/`hasBackup` |
| GET | `/apps/{app}/ingress?limit&offset&room&q` | ingress:read | ingress — paginated `{ data, total, limit, offset }` (limit 1..500, default 50). Each row: `room`, `status` (inactive/buffering/publishing/error/complete), `bitrate`, `width`/`height`, `viewers` (approx., null = unknown), `requires_password`, plus the revealable ingest credentials `rtmp_url` + `stream_key` |
| GET | `/apps/{app}/ingress/{id}` | ingress:read | ingress — annotated with `role` (`primary`/`backup`) + `pairedIngressId`; a primary also carries its sibling `backupStreamKey`/`backup_rtmp_url` |
| DELETE | `/apps/{app}/ingress/{id}` | ingress:delete | ingress — deleting a **primary** cascades its paired backup; deleting a backup only unlinks |
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
| GET | `/apps/{app}/streams/{id}/plugins` | stream:read | [streams](../features/streams.md) — the stream's per-stream plugin opt-out list `{ streamId, disabled:[pluginId] }`. `disabled` = plugins THIS stream is opted OUT of; `[]` (default) = affected by every app-enabled plugin |
| PATCH | `/apps/{app}/streams/{id}/plugins` | stream:write | streams — replace the opt-out list. Body `{ disabled:[pluginId] }`; `[]` re-affects the stream with all app plugins. Per-stream only — other streams unaffected |
| DELETE | `/apps/{app}/streams/{id}` | stream:stop | streams (204) |
| POST | `/apps/{app}/snapshots` | stream:write | [recording](../features/recording.md) (on-demand snapshot by room). Fires `stream.snapshot` |
| POST | `/apps/{app}/streams/{id}/snapshot` | stream:write | on-demand snapshot **by stream id** — works for LiveKit-backed streams (room composite) AND passthrough/HLS streams (latest on-disk HLS segment). Returns `{ key, url }`; fires `stream.snapshot`. 503 when no live source |
| POST | `/apps/{app}/streams/{id}/data` | stream:write | [chat/reactions](../features/chat-reactions-viewers.md) |

## Rooms (metadata + moderation + data push — LiveKit native)

Rutas por sala del app (el `:room` se namespacea bajo el room prefix del app —
aislamiento por tenant). Exponen las capacidades server-side nativas de LiveKit
(`RoomServiceClient`): metadata viva, moderación y push de data messages.

| Method | Path | Permission | Feature |
|--------|------|-----------|---------|
| GET | `/apps/{app}/rooms` | stream:read | Salas vivas del app (name, sid, numParticipants, metadata) |
| GET | `/apps/{app}/rooms/{room}` | stream:read | Una sala viva (404 si no está activa) con su metadata |
| PATCH | `/apps/{app}/rooms/{room}/metadata` | stream:write | `updateRoomMetadata` — body `{ metadata }` (string opaco, típicamente JSON). Los clientes reciben `roomMetadataChanged` |
| GET | `/apps/{app}/rooms/{room}/participants` | stream:read | Participantes con sus tracks publicados (sids) + grant actual — alimenta las acciones de moderación |
| DELETE | `/apps/{app}/rooms/{room}/participants/{identity}` | stream:write | Kick (`removeParticipant`) |
| POST | `/apps/{app}/rooms/{room}/participants/{identity}/mute` | stream:write | Mute server-side (`mutePublishedTrack`). Body `{ trackSid? , kind?: audio\|video\|all, muted?: bool=true }` |
| PATCH | `/apps/{app}/rooms/{room}/participants/{identity}` | stream:write | `updateParticipant` — metadata / name / permisos (`canPublish`/`canSubscribe`/`canPublishData`; el grant actual se mergea porque LiveKit aplica permisos de forma atómica). Los clientes reciben `participantMetadataChanged` |
| POST | `/apps/{app}/rooms/{room}/participants/{identity}/subscriptions` | stream:write | `updateSubscriptions` — body `{ trackSids: string[], subscribe: bool }` (force-subscribe/unsubscribe) |
| POST | `/apps/{app}/rooms/{room}/data` | stream:write | Push server-side de un data message a toda la sala (`sendData`) — gemelo por sala de `POST /streams/{id}/data`; respeta los gates `features.chat`/`features.reactions` para esos topics |

## Recording & VOD

| Method | Path | Permission | Feature |
|--------|------|-----------|---------|
| POST | `/apps/{app}/recording/start` | recording:start | [recording](../features/recording.md) — body acepta `recordMode: composite\|track\|audio` (+ `participantIdentity`): `track`/`audio` graban UN publisher vía TrackCompositeEgress (ffmpeg, **sin** Chrome headless); `composite` (default) mantiene el comportamiento del config del app |
| POST | `/apps/{app}/recording/{id}/stop` | recording:stop | recording |
| POST | `/apps/{app}/streams/{id}/record/start` | recording:start | recording (record-live) — body opcional `{ recordMode, participantIdentity }` (default del identity: el participant del stream) |
| POST | `/apps/{app}/streams/{id}/record/stop` | recording:stop | recording |
| GET | `/apps/{app}/vods?limit&offset` | vod:read | [vod](../features/vod.md) — `?source=recording\|clip` filtra por origen (G6); cada VOD trae `source` |
| GET | `/apps/{app}/vods/{id}` | vod:read | vod (url/presignedUrl/publicUrl) |
| POST | `/apps/{app}/vods/{id}/probe` | vod:write | vod — ffprobe backfill of `duration_s`/`width`/`height`/`format` for legacy VODs (local file or presigned S3 source; best-effort, returns `{ ...vod, probed }`) |
| DELETE | `/apps/{app}/vods/{id}` | vod:delete | vod (DB+S3+local cascade) |
| POST | `/apps/{app}/vods/{id}/transcribe` | vod:write | [plugins → transcription](../features/plugins.md#vod-transcription--speech-to-text--srt-for-recordings) — dispara (o re-corre) la transcripción del VOD; requiere el plugin `transcription` instalado + enabled. Asíncrono: responde el row en `queued`; 409 si el VOD no está `ready` o si ya hay una transcripción corriendo |
| GET | `/apps/{app}/vods/{id}/transcript` | vod:read | plugins → transcription — transcript del VOD: `status` (queued\|processing\|ready\|failed), `text`, `segments` timeados (con `speaker` por pista cuando es atribuible), `speakers`, `srtKey` + `srtUrl` (presigned del SRT subido al S3 del app, al lado del VOD). 404 si nunca se transcribió |
| GET | `/apps/{app}/vods/{id}/transcript.srt` | vod:read | plugins → transcription — descarga el archivo SRT (`application/x-subrip`, rebuild desde los segments guardados; funciona aunque el upload a S3 haya fallado). 409 mientras no esté `ready` |

## HLS live

| Method | Path | Auth | Feature |
|--------|------|------|---------|
| POST | `/apps/{app}/streams/{id}/hls/start` | stream:start | [hls-live](../features/hls-live.md) |
| POST | `/apps/{app}/streams/{id}/hls/stop` | stream:stop | hls-live |
| GET | `/apps/{app}/streams/{id}/hls` | stream:read | hls-live — con `features.dvr`, `playlistUrl` → `…/dvr.m3u8` y `dvr: {windowSeconds, segmentSeconds}` ([dvr-clips](../features/dvr-clips.md)) |

## Clips (G6)

| Method | Path | Permission | Feature |
|--------|------|-----------|---------|
| POST | `/apps/{app}/streams/{id}/clips` | vod:write | [dvr-clips](../features/dvr-clips.md#clips-g6) — `{from, to}` o `{eventTs, before, after}` (instantes epoch s/ms o ISO); 202 con el clip `queued`; corta con ffmpeg `-c copy` de los segmentos HLS/DVR → VOD `source: clip` en el S3 de la app + `clip.ready`. 400 apagado/rango inválido, 409 sin segmentos HLS o sin bucket, 429 con `max_queued` |
| GET | `/apps/{app}/streams/{id}/clips` | vod:read | dvr-clips — clips del stream (`?limit`, default 100) |
| GET | `/apps/{app}/clips` | vod:read | dvr-clips — clips de la app |
| GET | `/apps/{app}/clips/{clipId}` | vod:read | dvr-clips — estado `queued\|running\|ready\|failed`, `vodId`, `url` cuando está listo, `origin` (evento/corrida que lo pidió) |

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

## Scheduled live (agenda de estrenos)

`startAt` is an absolute unix epoch in **milliseconds (UTC)** — the browser
computes it from the picked wall-time + IANA timezone. `/public` is declared
before `/:id` so `public` is never captured as an id.

| Method | Path | Permission | Feature |
|--------|------|-----------|---------|
| GET | `/apps/{app}/scheduled-live/public?room=&sinceMs=` | public | [scheduled-live](../features/plugins.md#scheduled-live--countdown-to-a-premiere) — enabled, upcoming events for the player countdown |
| GET | `/apps/{app}/scheduled-live` | config:read | scheduled-live — the full operator agenda |
| POST | `/apps/{app}/scheduled-live` | config:write | scheduled-live — schedule a premiere (`{ startAt, timezone?, room?, title?, message?, enabled? }`) |
| PATCH | `/apps/{app}/scheduled-live/{id}` | config:write | scheduled-live — update an event (move `startAt`, enable/disable, …) |
| DELETE | `/apps/{app}/scheduled-live/{id}` | config:write | scheduled-live — delete an event |

## Live Control

Pause / resume / finish an already-live stream (owner item 31). Backed by the in-core `modules/live-control` service + per-app `live-control.db`; the `live-control` console (app-tab) and the `live-control-overlay` cover both use these routes. See [live-control](../features/live-control.md).

| Method | Path | Permission | Feature |
|--------|------|-----------|---------|
| GET | `/apps/{app}/plugins/live-control/public?stream=&room=` | public | live-control — public state + resolved cover for the anonymous player overlay (selected by `stream` id or `room`) |
| GET | `/apps/{app}/plugins/live-control/streams` | config:read | live-control — live streams + their control state |
| GET | `/apps/{app}/plugins/live-control/streams/{streamId}` | config:read | live-control — one stream + its control state |
| POST | `/apps/{app}/plugins/live-control/streams/{streamId}/pause` | config:write | live-control — pause (viewers see the cover, audio muted). Body (optional override) `{ mode?, assetId?, cardTitle?, cardText?, cardColor? }`. Fires `livecontrol.paused` |
| POST | `/apps/{app}/plugins/live-control/streams/{streamId}/resume` | config:write | live-control — resume the live feed (unmutes). Fires `livecontrol.resumed` |
| POST | `/apps/{app}/plugins/live-control/streams/{streamId}/finish` | config:write | live-control — finish with a final card/asset. Fires `livecontrol.finished` |
| GET | `/apps/{app}/plugins/live-control/assets` | config:read | live-control — list uploaded cover assets (signed URLs) |
| POST | `/apps/{app}/plugins/live-control/assets` | config:write | live-control — upload a cover asset (multipart `file`, image/* or video/*). 409 `storage_not_configured` when no S3 bucket |
| GET | `/apps/{app}/plugins/live-control/assets/{id}/url` | config:read | live-control — fresh signed preview URL |
| DELETE | `/apps/{app}/plugins/live-control/assets/{id}` | config:write | live-control — delete an asset (db row + S3 object) |
| GET | `/apps/{app}/plugins/live-control/settings` | config:read | live-control — per-app defaults (static + default pause/finish assets) |
| PUT | `/apps/{app}/plugins/live-control/settings` | config:write | live-control — set the default pause/finish cover assets (`null` clears) |

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

## Tenants & quotas

| Method | Path | Permission | Feature |
|--------|------|-----------|---------|
| GET | `/tenants` | superadmin | [quotas](../features/quotas.md) — every tenant `{ id, name, plan, createdAt, quotas, appCount }` |
| GET | `/tenants/{id}/usage` | usage:read (own tenant) | quotas — usage vs limits |
| PATCH | `/tenants/{id}/quotas` | superadmin | quotas — set plan + limits; body `{ plan?, maxApps?, maxConcurrentStreams?, maxRecordingMinutesMonth?, maxEgressGbMonth?, maxStorageGb? }` (partial; `-1` = unlimited) → updated tenant |

`GET /tenants` and `PATCH /tenants/{id}/quotas` are the platform-owner surface behind the Superadmin › Tenants screen. Both are superadmin-only and **always enforced** (independent of `STREAMHUB_AUTHZ_ENFORCE`): the break-glass admin and the global `sk_` token resolve to superadmin and keep access; any tenant-scoped principal gets 403. `PATCH` returns 404 for an unknown tenant and 400 for an invalid body.

## System / GPU

| Method | Path | Auth | Feature |
|--------|------|------|---------|
| GET | `/system/gpu?refresh` | Bearer | [transcoding-gpu](../features/transcoding-gpu.md) |
| POST | `/system/gpu/refresh` | Bearer | transcoding-gpu |
| GET | `/system/build` | Bearer (any principal) | About / Build panel (3.2+): `{ version, commit, buildDate, dirty, toolchain: { goVersion, compiler, goos, goarch, cgo, trimpath, module }, vcs }` (enveloped). `commit`/`buildDate` come from the ldflags stamp (`deploy/Dockerfile`, `deploy/make-core-bundle.sh`), else the Go toolchain's `vcs.*` build settings, else `""`; `dirty` is `vcs.modified` or `null` |
| GET | `/system/changelog` | Bearer (any principal) | About / Build panel (3.2+): `{ version, source: embedded\|file\|none, markdown }` (enveloped) — the repo-root `CHANGELOG.md`, embedded into the binary at build time (`go generate ./internal/buildinfo`); a binary built without it falls back to a `CHANGELOG.md` next to `VERSION` |
| GET | `/system/os-tuning` | global-scope (superadmin) | read-only [OS performance-tuning](../operations/OS-TUNING.md) posture: per kernel/limit knob (UDP buffers, `somaxconn`, `udp_mem`, ephemeral port range, fd limits, swappiness, THP) → `{ checkedAt, platform, supported, summary, knobs[], note }` (each knob: `id, label, source, key, current, recommended, status applied\|not-applied\|unknown, why, remedy, optional`). Reads `/proc` only; never writes — degrades to all-`unknown` on a non-Linux host |

## Network security (IP access control + auto-ban)

| Method | Path | Auth | Feature |
|--------|------|------|---------|
| GET | `/security/status` | global-scope (superadmin) | [network-security](../features/network-security.md) — mode + counts |
| GET | `/security/ip-rules` | global-scope (superadmin) | network-security — allow/block rules |
| POST | `/security/ip-rules` | global-scope (superadmin) | network-security — add rule `{ cidr, action, note? }` |
| DELETE | `/security/ip-rules/{id}` | global-scope (superadmin) | network-security — remove rule |
| GET | `/security/bans` | global-scope (superadmin) | network-security — `{ active, recent }` auto-bans |
| POST | `/security/bans/{ip}/unban` | global-scope (superadmin) | network-security — lift a ban |
| GET | `/security/offenses` | global-scope (superadmin) | network-security — recent offenders |

## Backups (SQLite snapshots)

| Method | Path | Auth | Feature |
|--------|------|------|---------|
| GET | `/system/backups` | global-scope (superadmin) | [backups](../operations/BACKUPS.md) — settings + per-DB snapshot inventory |
| POST | `/system/backups` | global-scope (superadmin) | backups — snapshot every SQLite DB now (+ prune) |
| POST | `/system/backups/restore` | global-scope (superadmin) | backups — restore a snapshot over the live DB; body `{ db, snapshot, confirm: true }` (integrity-checked, auto `.pre-restore` safety copy, audit-logged) |

## Security audit trail & compliance posture

| Method | Path | Auth | Feature |
|--------|------|------|---------|
| GET | `/system/audit` | global-scope (superadmin) | append-only security audit trail (ISO 27002 §8.15) — filters `action` (prefix), `actor`, `result` (`success\|failure\|deny`), `from`/`to` (ISO), `limit` (≤500), `offset`; → `{ entries, total, limit, offset }`, newest first |
| GET | `/system/audit/verify` | global-scope (superadmin) | hash-chain integrity of the trail → `{ ok, checked, brokenAt }` |
| GET | `/system/compliance` | global-scope (superadmin) | live posture of the ISO 27002 §8 technological controls → `{ checkedAt, summary, controls[] }` (each control: `id, name, iso, state active\|partial\|off\|unknown, detail`) |

The trail is INSERT-only (SQLite triggers reject UPDATE/DELETE) and hash-chained
(sha256 per row); retention defaults to 90 days via
`STREAMHUB_AUDIT_RETENTION_DAYS`. Recorded events: `auth.login` / `user.signup`
(success+failure), `token.create` / `token.revoke`, `authz.deny` (RBAC denials,
also in log-only mode), `app.create` / `app.delete`, `config.update` /
`config.revert` / `config.preset_apply`, `s3.update`, `mqtt.update`, `smtp.update`, `db.purge`,
`security.ip_rule.create` / `security.ip_rule.delete` / `security.unban`,
`moderation.*`.

## Vision Edge (cluster nodes + assignments)

Global-scope edge manager (like the cluster admin routes) — [vision-edge.md](../features/vision-edge.md). Node commands + log tail + assignments are driven over the edge WS control channel.

| Method | Path | Auth | Feature |
|--------|------|------|---------|
| GET | `/edge/nodes` | global-scope | list nodes with type/weight, live WS liveness (`connected`/`stale`) + last stats (cpu/mem/disk/grid) |
| PATCH | `/edge/nodes/{id}` | global-scope | set a node's `type` (`common`\|`edge`) and/or scheduling `weight` |
| POST | `/edge/nodes/{id}/command` | global-scope | send `restart`\|`reboot`\|`ping` over WS and await the result (`503` not connected, `504` timeout); audited |
| GET | `/edge/nodes/{id}/logs?lines` | global-scope | tail a connected node's edge-runtime log over WS (`lines` default 200, clamped 1–2000) |
| GET | `/edge/assignments?app` | global-scope | list edge assignments (optional `app` filter) |
| POST | `/edge/assignments` | global-scope | schedule a worker workload `{app, pluginId, streamId?, config?, policy?}` onto an edge node (parked pending when none eligible) |
| DELETE | `/edge/assignments/{id}` | global-scope | revoke an assignment (told to the node, then marked revoked) |

> The edge WS control channel itself is `GET /api/v1/edge/ws` (WebSocket upgrade, `X-Cluster-Token` + `?nodeId=` auth; not a REST route). Edge nodes dial it OUT.

## Devices (field encoders: pairing + control)

Zero-touch pairing and remote control of field encoders (`streamhub-encoder` and compatible devices) — [devices.md](../features/devices.md) has the full wire protocol. **Off by default** (`STREAMHUB_DEVICES_ENABLE=on`): while off every route answers `503` and the WS refuses. All bodies are the `{data, error:null}` envelope.

| Method | Path | Auth | Feature |
|--------|------|------|---------|
| POST | `/devices/pair/start` | public (device) | `{model?, version?, serial?}` → `201 {deviceId, code, displayCode, pollToken, expiresAt, pollInterval}`. Code: 8 symbols of `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, 10 min TTL, single use. Rate-limited per IP (10/min) and capped (5 live pairings per IP, 1000 total) → `429` |
| GET | `/devices/pair/{deviceId}?token=<pollToken>` | public (device: the poll token) | `{status:"pending", expiresAt}` until claimed; then **once** `{status:"claimed", deviceId, credential:"dk_…", wsUrl, app}`. Afterwards / unknown / expired / wrong token → `404 unknown or expired pairing` (5 wrong tokens burn the pairing). 120 polls/min per IP |
| POST | `/apps/{app}/devices/claim` | `app:write` | `{code, name?}` (case-insensitive, dashes/spaces ignored) → `201` device. Wrong/expired/used code → `404 invalid or expired pairing code`; 5 wrong codes lock the caller (30 s, doubling) and 30 attempts/min per IP → `429` |
| GET | `/apps/{app}/devices` | `app:read` | the app's devices: `online`, `lastSeenAt`, `capabilities` (from `hello`), latest `status`, `channels` |
| GET | `/apps/{app}/devices/{id}` | `app:read` | one device (`404 device not found` for another app's device) |
| GET | `/apps/{app}/devices/{id}/status` | `app:read` | `{id, online, lastSeenAt, status}` — the last `status` frame (+ `receivedAt`) |
| PATCH | `/apps/{app}/devices/{id}` | `app:write` | `{name}` rename (pushes a new `config`) |
| DELETE | `/apps/{app}/devices/{id}` | `app:write` | revoke: deletes the device and its channel ingresses; a live socket is closed `4401`; the credential is refused from then on. Audited (`device.revoke`) |
| POST | `/apps/{app}/devices/{id}/commands` | `app:write` | `{action: start\|stop\|restart\|apply_preset\|reboot, channel?, preset?, confirm?}` (`channel` for start/stop/restart/apply_preset, `preset` for apply_preset, `confirm:true` for reboot) → `{id, ok, message}`; `503 device not connected`, `504 device did not respond in time` (10 s). Audited (`device.command`) |
| GET | `/apps/{app}/devices/{id}/channels` | `app:read` | the device's linked channels (`room`, `protocol`, `ingressId`, `publishUrl`, `streamKey`) |
| PUT | `/apps/{app}/devices/{id}/channels/{channel}` | `app:write` | link channel → room `{room, protocol: rtmp\|srt, name?}`: the core creates the ingress with the `POST /ingress` logic (quotas, `rtmp.passthrough`; `srt` = passthrough) for the caller and pushes it in `config`; re-linking replaces (and deletes) the old ingress. `channel` matches `^[A-Za-z0-9._-]{1,64}$` |
| DELETE | `/apps/{app}/devices/{id}/channels/{channel}` | `app:write` | unlink: deletes the ingress, pushes the new `config` (`404 channel not found`) |

> `GET /apps/{app}/streams` and `/streams/{id}` add `sourceDevice: {deviceId, name, channel}` to a stream whose room a linked device channel feeds (absent otherwise).

> The device control channel is `GET /api/v1/devices/ws` (WebSocket upgrade with `Authorization: Device <dk_…>`; `401` bad/revoked credential, `503` plane off). Devices dial it OUT (works behind NAT/CGNAT).

## Admin

| Method | Path | Auth | Feature |
|--------|------|------|---------|
| POST | `/admin/restart` | global-scope token | [config-editor](../features/config-editor.md) |

## Observability & health

| Method | Path | Auth | Feature |
|--------|------|------|---------|
| GET | `/health` | public | [observability](../features/observability.md) |
| GET | `/stats` | Bearer | observability |
| GET | `/logs` | global-scope (superadmin) | observability — server-wide feed; tenants/app tokens use `/apps/{app}/logs` |
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
