# StreamHub — `config.yaml` Reference (per app)

Every app has a `config.yaml` at `apps/<name>/config.yaml`. It is the versionable source
of truth for that tenant's behaviour. **S3 credentials never live here** — only `*_env`
references; the real values live in `data/secrets.json` (chmod 600).

> **Secret refs are server-derived (3.3.3).** Every `*_env` key (`s3.access_key_env`,
> `s3.secret_key_env`, `mqtt.password_env`, `smtp.pass_env`,
> `features.drm.key_server_token_env`) is **not chosen by the config author**: the core
> derives it from the app name as `APP_<SLUG>_<KIND>` (`<SLUG>` = the name upper-cased
> with each `-` turned into `_`; kinds `S3_KEY`, `S3_SECRET`, `MQTT_PASSWORD`, `SMTP_PASS`,
> `DRM_TOKEN`) and reads/writes only that `secrets.json` key. In the yaml the key is a
> mirror: omit it, or write exactly the derived name — any other value is rejected by the
> raw editor with `400 secret refs are managed by the server; use PUT /apps/:app/<s3|smtp|mqtt>`.
> A legacy yaml with a foreign ref is ignored with a warning and rewritten at boot (the
> value moves along only when the ref was the app's own pre-3.3.3 name). Values are never
> read from the process environment, except for **platform-tenant** apps, which fall back
> to an env var of the same derived name (fixed allowlist: those five refs only).

When loaded by streamhub-core the YAML is parsed into an `AppConfig` object with the S3
credentials already resolved. The API exposes/edits it via:

- global `PATCH /apps/{name}` — displayName, roomPrefix, recording toggle, callbacks;
- per-app `GET/PATCH /apps/{app}/config` — adaptive/transcoding (webrtc layers, rtmp
  transcode);
- per-app **presets** `GET /apps/{app}/presets` + `POST /apps/{app}/presets/{name}/apply` +
  `POST /apps/{app}/presets/{name}/deactivate` — apply (or revert) a delivery/quality
  profile (`low-latency` / `high-quality-recording` / `mass-audience-HLS` /
  `rtmp-passthrough`) as a credential-safe deep-merge + hot-reload. See
  [features/presets.md](./features/presets.md).

See [api-global.md](./api-global.md) and [api-app.md](./api-app.md).

---

## Full example

```yaml
name: live
display_name: Live
room_prefix: live
timezone: ""                     # IANA zone (e.g. America/Argentina/Buenos_Aires); empty = server default

recording:
  enabled: true
  mode: room-composite          # room-composite | participant
  layout: grid
  local_dir: recordings
  delete_local_after_upload: true
  split_minutes: 0              # 0 | 15 | 30 | 60 | 90 | 120 (0 = single file)
  snapshot_seconds: 0           # 0 | 1 | 30 | 60 | 120 | 360 (0 = off)
  filename_template: ""         # e.g. ${app}_${room}_${date:yyyyMMdd-HHmmss} (empty = default)
  snapshot_template: ""         # e.g. ${room}_snap_${ts} (empty = default)
  retention_days: 0             # 0=off | 7 | 30 | 90 | 180 | 360 (delete VODs older than N days)

s3:
  provider: wasabi              # aws | wasabi | minio
  bucket: my-bucket
  region: us-east-1
  endpoint: https://s3.us-east-1.wasabisys.com   # empty for plain AWS
  force_path_style: false       # true for minio (path-style)
  prefix: streamhub/live
  access_key_env: APP_LIVE_S3_KEY      # credential REFERENCES, not values
  secret_key_env: APP_LIVE_S3_SECRET
  storage_class: STANDARD_IA    # optional (3.4.0): S3 storage class of every upload; absent = provider default

webrtc:
  adaptive: true
  transcode_max_height: 720      # ingress transcode cap: 360|480|720|1080 (default 720)
  layers:
    - { name: high, height: 720 }
    - { name: med,  height: 480 }
    - { name: low,  height: 240 }

rtmp:
  enabled: true
  transcode: true                # sub-preference; only acts when transcoding.enabled

# Server-side transcoding (master switch + recording/VOD outputs).
# NEW apps ship with enabled: false → pure PASSTHROUGH (no re-encode anywhere).
transcoding:
  enabled: false                 # master switch (opt-in)
  encoding: h264                 # h264 | h264+vp8 (adds a WebM/VP8 alternate per VOD)
  vod_adaptive: false            # adaptive HLS VOD (master playlist + renditions)
  vod_renditions: []             # explicit ladder; empty = derived from webrtc.layers
  # vod_renditions:
  #   - { height: 720, bitrate_kbps: 2800 }
  #   - { height: 480, bitrate_kbps: 1400 }
  #   - { height: 240, bitrate_kbps: 500 }

callbacks:
  url: ""                       # POST signed events here (empty = disabled)
  secret: ""                    # HMAC-SHA256 signing secret

# Per-app MQTT event publishing (in ADDITION to callbacks). The broker
# password NEVER lives here — only the `password_env` REFERENCE (server-derived);
# the value is resolved from data/secrets.json (like the S3 credentials).
mqtt:
  enabled: false                # master switch
  url: ""                       # mqtt:// | mqtts:// | ws:// | wss:// (path ok)
  username: ""
  password_env: APP_LIVE_MQTT_PASSWORD   # credential REFERENCE, not the value
  topic_prefix: streamhub/live  # topics: <prefix>/<category>/<event>
  qos: 0                        # 0 | 1 | 2
  tls: false                    # force TLS (mqtt:// upgraded to mqtts://)
  events: [all]                 # 'all' or an explicit list of event names
  logs:
    enabled: false              # forward app logs to <prefix>/log/<level>
    level: info                 # minimum forwarded level
  subscribe:                    # MQTT data-IN: each inbound msg → iot.data event
    - topic: sensors/+/temp     # topic filter (MQTT wildcards + / # allowed)
    - topic: devices/#          # → dispatch(app,'iot.data',{topic,data,source:'mqtt'})

# Per-app SMTP override (owner item 29). The password NEVER lives here — only
# the `pass_env` REFERENCE (server-derived); the value is resolved from
# data/secrets.json (like the S3/MQTT credentials). When enabled, this app's
# notifications (the notifier email channel) use it instead of the global
# STREAMHUB_SMTP_* default — UNLESS the recipient user has their own SMTP
# override configured (PUT /account/smtp), which takes priority. See
# features/smtp.md for the full per-app + per-user precedence.
smtp:
  enabled: false                 # master switch
  host: ""
  port: 587                      # 587 = STARTTLS; 465 = implicit TLS
  user: ""
  from: ""                       # e.g. "My App <no-reply@example.com>"
  pass_env: APP_LIVE_SMTP_PASS   # credential REFERENCE, not the value

# Stream latency/health alerting: emits stream.latency_high /
# stream.latency_recovered through BOTH callbacks and MQTT.
latency_alert:
  enabled: false
  threshold_ms: 1000            # probe-RTT breach threshold
  cooldown_seconds: 60          # min seconds between alerts per room
  interval_seconds: 10          # sampling interval

# Per-app + per-stream quotas. OPTIONAL — the whole block (and any value <= 0 /
# -1) means UNLIMITED, which is the default. Complements the per-tenant quotas
# (control-plane). Enforced when STREAMHUB_AUTHZ_ENFORCE=on; superadmin / GLOBAL
# API tokens are never limited (app-scoped tokens are, since 3.3.4).
quotas:
  max_concurrent_streams: -1      # max simultaneous live streams for THIS app (-1 = unlimited)
  max_viewers_per_stream: -1      # max viewers on a single stream (-1 = unlimited)

# Wave-2 optional features (SPEC §16). All default to sensible off/safe values.
features:
  rtmp_password: true           # require a password in addition to the stream key
  viewer_counter: true          # expose subscriber count per stream
  chat: true                    # data channels: chat + emojis
  reactions: true               # animated reactions
  hidden_qc: true               # allow hidden QC/recorder participants
  adaptive_player: true         # player uses adaptive (simulcast/HLS) playback
  ws_ingest:                    # direct WS MJPEG ingest (ESP32-CAM) — optional block
    enabled: true               # default true; false disables /ingest/ws for the app
    max_cameras: 0              # 0 = unlimited concurrent ws-mjpeg cameras
    max_fps: 15                 # server-side fps cap per camera (excess dropped)
    max_frame_kb: 256           # max accepted JPEG frame size (bigger → close 4413)
    max_data_bytes: 16384       # max {"type":"data"} frame size (bigger → dropped)
    max_data_per_sec: 5         # per-socket data-frame rate cap (own token bucket)
  auto_record: false            # start a recording automatically when a room opens
  linear:                       # 24/7 linear-channel knobs (endless-radio Tier 1) — optional block, all OFF
    persistent_room: false      # QW-1: pre-create the room with a long emptyTimeout so a source outage never recycles it
    room_empty_timeout_seconds: 86400   # emptyTimeout (s) for the pre-created room (default 24h)
    always_on_hls: false        # QW-2: watchdog relaunches a dead HLS egress for this app's active rooms
    dvr: false                  # QW-4: serve the rolling live playlist as the public manifest + prune old .ts
    dvr_window_seconds: 3600    # QW-4: DVR retention window (s); older segments pruned (default 1h)
  hls:                          # G5 — AMS hlsTime / hlsListSize — optional block (absent = 4 s, full playlist)
    segment_seconds: 4          # hlsTime: live HLS egress segment length, 1..30 s
    list_size: 0                # hlsListSize: segments in the served playlist (dvr.m3u8); 0 = all (index.m3u8)
  dvr:                          # G5 — rewindable window per stream — optional block, OFF
    enabled: false              # serve dvr.m3u8 (sliding window), keep the egress up, prune past the window
    window_minutes: 60          # 1..1440; hlsListSize derived = ceil(window·60 / segment_seconds)
  clips:                        # G6 — instant/event clips from the HLS/DVR segments — optional block, OFF
    enabled: false
    max_seconds: 120            # longest clip, 1..600
    max_concurrent: 2           # ffmpeg jobs at once per app, 1..8
    max_queued: 20              # queued+running per app before 429, 1..200
  drm:                          # encrypt the packaged VOD/HLS output — optional block (default OFF)
    enabled: false              # master switch; false = clear packaging, pipeline unchanged
    provider: none              # none (noop) | external (SPEKE-style key server)
    systems: [widevine, playready, fairplay]
    scheme: cbcs                # cbcs (CMAF one-encode) | cenc (no FairPlay)
    key_server_url: ""          # external key-server POST endpoint (empty = unconfigured)
    key_server_token_env: ""    # "" = no token; else exactly APP_<SLUG>_DRM_TOKEN (server-derived secrets.json key)
    license_urls: { widevine: "", playready: "", fairplay: "" }
    fairplay_cert_url: ""       # FairPlay application certificate URL (Safari)
    fail_open: false            # false = fail CLOSED (skip variants); true = degrade to clear
  allowed_publisher_cidr: []    # optional (3.4.0): publish only from these networks, e.g. ["203.0.113.0/24"]; absent/[] = anyone
  max_bitrate_accept: 0         # optional (3.4.0): cut an ingress above N bits/s (video+audio); absent/0 = no cap

# Per-app plain-config variables, referenced from filename templates as ${var.NAME}.
# NOT secrets — plain config, returned by GET config. Keys must be [A-Za-z0-9_].
variables:
  site: HQ
  channel: main
```

---

## Top-level

| Key | Type | Default | Notes |
|-----|------|---------|-------|
| `name` | string | — | App slug (unique). Matches `apps.name`. |
| `display_name` | string | `name` | Human label. Editable via `PATCH /apps/{name}`. |
| `room_prefix` | string | `name` | LiveKit room namespace. Rooms become `<prefix>` or `<prefix>-<room>`. |
| `timezone` | string | `""` | Per-app IANA timezone (owner item 11), e.g. `America/Argentina/Buenos_Aires`. Empty = server/host local time. Renders app-scoped dashboard timestamps in this zone and is the DEFAULT for any plugin/schedule config that leaves its own timezone empty (an explicit plugin-level timezone always wins). Editable via `PATCH /apps/{name}` (`timezone`); validated server-side against the runtime's IANA zone list (400 on an unrecognized value). See [features/timezone.md](./features/timezone.md). |

Maps to `AppConfig.name` / `displayName` / `roomPrefix` / `timezone`.

## `recording`

| Key | Type | Default | Notes |
|-----|------|---------|-------|
| `enabled` | boolean | `true` | Toggle recording for the app (also via `recordingEnabled` in `PATCH /apps/{name}`). |
| `mode` | `room-composite` \| `participant` | `room-composite` | Composite of the whole room, or a single participant. Used by `POST /recording/start`. |
| `layout` | string | `grid` | Egress composite layout (e.g. `grid`, `speaker`). |
| `local_dir` | string | `recordings` | Subdir under `apps/<name>/` for temp MP4s before upload. Since 3.3.3: ONE plain directory name (`^[A-Za-z0-9._-]{1,64}$`, no `..`, not `.`) — the raw editor rejects anything else with a 400, and a recording start with an invalid value is a 400 (no egress). |
| `delete_local_after_upload` | boolean | `true` | Delete the local file once the S3 upload succeeds. |
| `split_minutes` | number | `0` | Split the recording into N-minute MP4 parts (each part = its own VOD). `0` = one continuous file. UI/allowed: `0\|15\|30\|60\|90\|120`. Also settable via `splitMinutes` in `PATCH /apps/{name}`. |
| `snapshot_seconds` | number | `0` | Capture a JPEG snapshot every N seconds during recording (egress ImageOutput). `0` = off. UI/allowed: `0\|1\|30\|60\|120\|360`. Also `snapshotSeconds` in `PATCH /apps/{name}`. |
| `filename_template` | string | `""` | Filename/S3-key template for **recordings** (`${}` dialect — see below). Empty = built-in `<streamId-slug>-<epoch>` naming. `filenameTemplate` in `PATCH /apps/{name}`. |
| `snapshot_template` | string | `""` | Filename/S3-key template for **snapshots** (same dialect; `${type}` = `jpg`). Empty = built-in naming. `snapshotTemplate` in `PATCH /apps/{name}`. |
| `retention_days` | number | `0` | VOD retention window in **days**: `0` = OFF (keep forever). Allowed: `7\|30\|90\|180\|360`. A periodic janitor deletes VODs older than the window (measured from `started_at`) from **both** the app DB and the app's S3 storage. `retentionDays` in `PATCH /apps/{name}`. See below. |

### VOD retention / rotation (`retention_days`)

When `> 0`, a background janitor (default hourly) deletes VODs whose `started_at`
is older than the window. Deletion is a full cascade via the same path as
`DELETE /apps/{app}/vods/{id}`, in a deliberate ORDER: **S3 objects first
(best-effort — each per-object failure is logged), then the DB row
unconditionally.** Rationale: the DB row is the pointer to the S3 keys, so we
attempt the remote delete while we still hold them; the row is then always
reclaimed even if S3 was unreachable (a stray object can be mopped up by a re-run
or an S3 lifecycle rule, but a stuck DB row could never be cleared). In-flight
VODs (`recording`/`uploading`) are never touched. Env: `STREAMHUB_VOD_RETENTION`
(`on`/`off`, default on) and `STREAMHUB_VOD_RETENTION_INTERVAL_S` (default 3600,
min 60).

### Filename templates (`filename_template` / `snapshot_template`)

Naming with a `${}` token dialect. The template renders to a
**single safe filename segment** — path separators and `..` are neutralized, so
a template can **never** traverse out of the recordings/snapshots dir or the
app's S3 prefix. The container extension (`.mp4` / `.jpg`) is always appended by
core, and the same rendered name is used for the **local file AND the S3 key**.
Leave empty to keep the built-in naming (safe fallback).

| Token | Expands to |
|-------|-----------|
| `${app}` | App slug |
| `${streamId}` | Stream id (canonical `${room}/${identity}` or a slug) |
| `${room}` | Room name |
| `${type}` | Output type without the dot (`mp4` \| `jpg`) |
| `${ts}` | Unix epoch **seconds** at render time |
| `${date:FORMAT}` | UTC timestamp; FORMAT tokens `yyyy yy MM dd HH mm ss` (anything else literal) |
| `${var.NAME}` | Per-app [`variables`](#variables) entry `NAME` (missing → empty) |

Unknown tokens expand to empty (never leaked verbatim). Example:
`${app}_${room}_${date:yyyyMMdd-HHmmss}` → `live_lobby_20260713-090507.mp4`.
Include a time token (`${ts}` or `${date:…}`) for uniqueness — a template with no
time component can overwrite an earlier recording of the same stream.

## `s3`

Resolved into `S3Config`. Multi-provider via `@aws-sdk/client-s3`.

| Key | Type | Default | Notes |
|-----|------|---------|-------|
| `provider` | `aws` \| `wasabi` \| `minio` | — | Storage backend. |
| `bucket` | string | — | Target bucket. |
| `region` | string | — | e.g. `us-east-1`. |
| `endpoint` | string | empty | Full URL for Wasabi/MinIO; empty for plain AWS. |
| `force_path_style` | boolean | `false` | `true` for MinIO (path-style addressing). |
| `prefix` | string | — | Key prefix inside the bucket, e.g. `streamhub/live`. |
| `access_key_env` | string | `APP_<SLUG>_S3_KEY` | **Server-derived** `secrets.json` key of the access key (omit it, or write exactly the derived name; anything else → 400). Set the value with `PUT /apps/{app}/s3` (`key`). |
| `secret_key_env` | string | `APP_<SLUG>_S3_SECRET` | **Server-derived** `secrets.json` key of the secret key (same rule). Set the value with `PUT /apps/{app}/s3` (`secret`). |
| `storage_class` | string | absent (provider default) | **3.4.0** (↔ AntMedia `s3StorageClass`). S3 storage class sent on **every** upload of the app (recordings, VOD renditions, snapshots, future clips): one of `STANDARD`, `REDUCED_REDUNDANCY`, `STANDARD_IA`, `ONEZONE_IA`, `INTELLIGENT_TIERING`, `GLACIER`, `DEEP_ARCHIVE`, `GLACIER_IR`, `OUTPOSTS`, `EXPRESS_ONEZONE` (case-insensitive, stored upper-case). Set with `PUT /apps/{app}/s3` (`storageClass`; `""` clears it — an unknown class answers 400). An unknown value hand-written in the YAML resolves to the default and is never sent. Resolved as `S3Config.storageClass` (absent from JSON when unset). **Provider caveat:** Wasabi and most MinIO setups accept only `STANDARD` (MinIO also `REDUCED_REDUNDANCY`) and reject other classes on upload; `GLACIER`/`DEEP_ARCHIVE` objects must be restored before a presigned playback URL works. |

> Security: only the `*_env` reference names are stored in `config.yaml`, and they are
> derived by the server (see the note at the top). The actual access/secret keys are read
> from `data/secrets.json` (chmod 600) and
> resolved into `S3Config.accessKey` / `secretKey` at load time. The UI sets credentials
> via the API; core persists them outside the versionable YAML. They are never returned
> by `GET /apps/{app}/config`.

> **Switching `provider`**: `PUT /apps/{app}/s3` clears `endpoint` to `""` (the
> AWS SDK's regional default) whenever you set `provider: "aws"` **without**
> also passing an explicit `endpoint` in the same request. This matters because
> a scaffolded app defaults to the Wasabi `endpoint` — without the auto-clear,
> flipping `provider` to `aws` alone would silently keep uploading to Wasabi
> with AWS credentials. Passing an explicit `endpoint` always wins, regardless
> of `provider`.

## `webrtc`

The adaptive/transcoding ladder. Editable via `GET/PATCH /apps/{app}/config` and read by
`GET /apps/{app}/transcoding/layers`.

| Key | Type | Default | Notes |
|-----|------|---------|-------|
| `adaptive` | boolean | `true` | Enable adaptive (simulcast) WebRTC delivery. Also drives the **ingress** transcode: only `adaptive: true` produces a (capped) multi-layer ingest; otherwise a single ingress layer (the CPU safeguard). |
| `transcode_max_height` | `360` \| `480` \| `720` \| `1080` | `720` | **Efficient transcode profile** — resolution cap (px height) for the RTMP/URL ingress transcode. Bounds CPU: a single-layer ingest re-encodes to this height, an adaptive ingest caps its TOP ladder layer here. PATCH via `transcodeMaxHeight` (out-of-set → 400; hand-edited yaml is snapped to the nearest tier). See `features/efficient-transcode.md`. |
| `layers` | list of `{ name, height }` | `[{high,720},{med,480},{low,240}]` | Rendition ladder. `name` is a short slug; `height` 1..4320 (width derived by LiveKit from the source aspect). 1..8 entries; a PATCH `layers` replaces the whole ladder. |

## `rtmp`

| Key | Type | Default | Notes |
|-----|------|---------|-------|
| `enabled` | boolean | `true` | Allow RTMP ingress for the app. |
| `transcode` | boolean | `true` | Sub-preference for `enableTranscoding` on RTMP/URL ingress (multi-layer). **Only takes effect when `transcoding.enabled` is true** — with the master switch off, ingress is always passthrough. |

> **RTMPS (TLS ingest)** is a deployment-wide (env) toggle, not a per-app key.
> When `STREAMHUB_RTMPS_ENABLE=true` and the `rtmps` compose profile is running,
> the ingress endpoints return an `rtmps_url` (encrypted push) next to `rtmp_url`
> for every app. See [features/ingress.md](./features/ingress.md#rtmps-tls-terminated-rtmp-in)
> and [operations/ENV.md](./operations/ENV.md#rtmps-ingest-tls-terminated-rtmp-in).

> **Passthrough transports (RTMP / SRT push + MPEG-TS pull)** are a
> deployment-wide (env) switch (`STREAMHUB_RTMP_PASSTHROUGH_ENABLE`), selected
> per-ingress at create time (`{mode:'passthrough'}`), not a per-app `config.yaml`
> key. `rtmp.passthrough` (when present) only sets the DEFAULT mode for a new RTMP
> ingress; SRT and MPEG-TS always require an explicit `mode:'passthrough'`. The
> MPEG-TS-over-UDP (unicast + multicast) PULL source has no per-app config — its
> `udp://@GROUP:PORT` + SSM/interface/buffer options are supplied on the ingress
> create body. See [features/mpegts-multicast.md](./features/mpegts-multicast.md).

## `transcoding`

Server-side transcoding master switch + recording/VOD output targets. Editable via
`PATCH /apps/{app}/config` (`transcodingEnabled`, `encoding`, `vodAdaptive`,
`vodRenditions`). See [features/adaptive-vod.md](./features/adaptive-vod.md) for the
pipeline architecture (what LiveKit egress does vs the ffmpeg post-transcode).

| Key | Type | Default | Notes |
|-----|------|---------|-------|
| `enabled` | boolean | **`false`** | Master switch. A NEW app is created with transcoding **disabled** (pure passthrough): RTMP ingress is not re-encoded and each recording is a single MP4/H.264. Everything below is inert until this is `true`. |
| `encoding` | `h264` \| `h264+vp8` | `h264` | Recording output target. `h264` = the egress-native MP4 only. `h264+vp8` additionally generates a WebM/VP8 (+Opus) alternate per recording via an ffmpeg post-transcode job (the LiveKit egress cannot emit VP8). |
| `vod_adaptive` | boolean | `false` | Generate an **adaptive HLS VOD** per recording: one H.264 rendition per ladder step plus a master `.m3u8` referencing them, uploaded to the app's S3 and stored as VOD *variants* (the base MP4 VOD stays untouched). |
| `vod_renditions` | list of `{ height, bitrate_kbps }` | `[]` | Explicit VOD ladder. Empty = derived from `webrtc.layers` heights with default bitrates (2160→12000, 1440→8000, 1080→5000, 720→2800, 480→1400, 360→800, 240→500, 144→250 kbps). Invalid entries are dropped, duplicates deduped, sorted highest-first, capped at 5. |

> **Back-compat**: a `config.yaml` that predates this block resolves
> `enabled` from the legacy `rtmp.transcode` value, so pre-existing apps keep their
> historical behaviour until explicitly reconfigured. New apps always get the block
> written with `enabled: false`.

> **Scope**: `transcoding.enabled` gates *server-side* work (RTMP-ingress re-encode +
> VOD post-processing). WebRTC **simulcast** (`webrtc.adaptive`) is client-side layered
> encoding through the SFU — it is *not* server transcoding and stays independent.

## `callbacks`

| Key | Type | Default | Notes |
|-----|------|---------|-------|
| `url` | string | `""` | Outbound webhook URL. Empty = callbacks disabled. Editable via `PATCH /apps/{name}` (`callbackUrl`). |
| `secret` | string | `""` | Shared secret for `X-StreamHub-Signature` (HMAC-SHA256). Editable via `callbackSecret`. |

See [webhooks.md](./webhooks.md) for envelope, headers, signing and retries.

## `mqtt`

Per-app MQTT event publishing — every callback event (plus, optionally, the app's
log stream) is ALSO published as JSON to the app's broker. Editable via
`GET/PUT /apps/{app}/mqtt` (password masked on read) or the raw editor (refs only).
Full feature doc: [features/mqtt.md](./features/mqtt.md).

| Key | Type | Default | Notes |
|-----|------|---------|-------|
| `enabled` | boolean | `false` | Master switch. Off = no connection is kept, nothing is published. |
| `url` | string | `""` | Broker URL: `mqtt://`, `mqtts://`, `ws://` or `wss://` (path allowed, e.g. `wss://mqtt.streamhub.studio/mqtt`). Empty = off. |
| `username` | string | `""` | Broker username (empty for anonymous brokers). |
| `password_env` | string | `APP_<SLUG>_MQTT_PASSWORD` | **Server-derived** `secrets.json` key holding the broker password (omit it, or write exactly the derived name; anything else → 400). The value is set via `PUT /apps/{app}/mqtt` (`password`) and NEVER stored in the yaml; on reads it is masked (like the S3 credentials). |
| `topic_prefix` | string | `streamhub/<app>` | Topic root. Messages go to `<prefix>/<category>/<event>` (see features/mqtt.md for the category map). |
| `qos` | `0` \| `1` \| `2` | `0` | Publish QoS for every message. |
| `tls` | boolean | `false` | Force TLS: `mqtt://` is upgraded to `mqtts://` (and `ws://` to `wss://`) before connecting. `mqtts://`/`wss://` URLs already use TLS regardless. |
| `events` | list | `[all]` | Event filter: `all` (whole taxonomy) or an explicit list of event names (e.g. `[vod_ready, stream.latency_high]`). |
| `logs.enabled` | boolean | `false` | Forward the app's log stream to `<prefix>/log/<level>`. |
| `logs.level` | level | `info` | Minimum forwarded level (`trace|debug|info|warn|error|fatal`). |
| `subscribe` | list | `[]` | **MQTT data-IN** (IoT data plane): a list of `{ topic }` filters (MQTT wildcards `+`/`#` allowed) the core subscribes to on this same broker. Each inbound message becomes one `iot.data` event — `dispatch(app,'iot.data',{topic, deviceId:undefined, data, source:'mqtt'})` — which fans out to the signed webhook + MQTT-out + Streamflow's `trigger.mqtt`. Body parsed as JSON when valid, else the raw string. Capped at 64 filters. See [integrations/ESP32-WS-INGEST.md](./integrations/ESP32-WS-INGEST.md). |

## `smtp`

Per-app SMTP override (owner item 29). When enabled, this app's notifications
(the notifier email channel) are sent through it instead of the global
`STREAMHUB_SMTP_*` default — unless the recipient user has their own SMTP
override configured (`PUT /account/smtp`), which takes priority (precedence:
per-user > per-app > global). Editable via `GET/PUT /apps/{app}/smtp`
(password masked on read) or the raw editor (`pass_env` ref only — an inline
`pass` in the raw yaml is ignored with a warning, like `s3.key`/`s3.secret`
and `mqtt.password`). Test with `POST /apps/{app}/smtp/test { to }` (bypasses
the `enabled` gate). Full feature doc: [features/smtp.md](./features/smtp.md).

| Key | Type | Default | Notes |
|-----|------|---------|-------|
| `enabled` | boolean | `false` | Master switch. Off = this app's notifications use the global SMTP default. |
| `host` | string | `""` | SMTP server hostname. |
| `port` | number | `587` | `587` → STARTTLS; `465` → implicit TLS. Any other value is treated as STARTTLS. |
| `user` | string | `""` | SMTP auth username. |
| `from` | string | `""` | From header on mail sent through this app's SMTP, e.g. `My App <no-reply@example.com>`. Empty falls back to the global `STREAMHUB_SMTP_FROM`. |
| `pass_env` | string | `APP_<SLUG>_SMTP_PASS` | **Server-derived** `secrets.json` key holding the SMTP password (omit it, or write exactly the derived name; anything else → 400). The value is set via `PUT /apps/{app}/smtp` (`pass`) and NEVER stored in the yaml; on reads it is masked (like the S3/MQTT credentials). |

## `latency_alert`

Per-app stream health alerting (see [features/mqtt.md](./features/mqtt.md#high-latency-alert)
for the metric). On breach the core emits `stream.latency_high` — and later
`stream.latency_recovered` — through BOTH the callbacks pipeline and MQTT.
Editable via `PUT /apps/{app}/mqtt` (`latencyAlert` block).

| Key | Type | Default | Notes |
|-----|------|---------|-------|
| `enabled` | boolean | `false` | Master switch for the monitor. |
| `threshold_ms` | number | `1000` | Breach threshold for the per-room probe RTT (ms). |
| `cooldown_seconds` | number | `60` | Minimum seconds between successive `stream.latency_high` alerts for the same room. |
| `interval_seconds` | number | `10` | Sampling interval per app (min 2). |

---

## `features` (SPEC §16)

All optional, per-app, with sensible defaults. These enable the wave-2 capabilities.

| Key | Type | Default | Effect |
|-----|------|---------|--------|
| `rtmp_password` | boolean | `false` | Each RTMP ingress also issues a `stream_password`; a push is only accepted if the key **and** password match. The UI surfaces the RTMP URL, key, and password. |
| `viewer_counter` | boolean | `false` | Per room/stream subscriber count (publishers and hidden/QC excluded), surfaced on `GET /apps/{app}/streams/{id}` (`lastStatsJson` → participants/publishers) and on events; the player shows it live. |
| `chat` | boolean | `false` | Enables the chat widget over the LiveKit `chat` data-channel topic (messages + emojis). Fires the `chat_message` callback. |
| `reactions` | boolean | `false` | Enables animated reactions over the `reaction` topic (floating hearts/likes). Fires the `reaction` callback. |
| `hidden_qc` | boolean | `false` | Allows minting hidden QC/recorder tokens (`hidden: true`, `recorder: true`) that subscribe to all media but stay invisible and uncounted. |
| `adaptive_player` | boolean | `false` | The associated player uses adaptive playback: simulcast for live; HLS renditions for VOD when available. |
| `ws_ingest` | object | enabled | Direct WebSocket MJPEG ingest for ESP32-CAM class devices (`wss://<domain>/ingest/ws` — see [integrations/ESP32-WS-INGEST.md](./integrations/ESP32-WS-INGEST.md)). Sub-keys: `enabled` (bool, default `true`), `max_cameras` (int, `0` = unlimited), `max_fps` (int, default `15` — excess frames dropped server-side), `max_frame_kb` (int, default `256` — a bigger frame closes with 4413), `max_data_bytes` (int, default `16384` — a bigger `{"type":"data"}` structured-data frame is dropped, never closes), `max_data_per_sec` (int, default `5` — per-socket data-frame rate cap on its own token bucket). Structured data frames are routed as `iot.data` events. |
| `auto_record` | boolean | `false` | **Auto-record on room start**: when a room of the app opens (any path — WebRTC join, RTMP/WHIP/URL ingress), the `room_started` webhook starts a recording automatically (same flow as `POST /recording/start`, honouring the app's split/snapshot config). Requires `recording.enabled: true` — with recording disabled the attempt is logged and skipped. Best-effort: an auto-record failure never affects the room. NOTE: read raw from the YAML by the webhook sink (not yet part of the resolved `AppConfig.features` contract), so today it is set by editing `config.yaml` directly. |
| `linear` | object | all off | **24/7 linear-channel** knobs (endless-radio Tier 1). Resolved into `AppConfig.features.linear` (all defaults present); set via `config.yaml`. Sub-keys below. With every flag off the app behaves exactly like a normal stream/conference app. |
| `linear.persistent_room` | boolean | `false` | **QW-1**: the ingress-create endpoint PRE-creates the LiveKit room with a long `emptyTimeout` **before** `createIngress`, so a brief source outage never recycles the room (which would change its SID and drop every viewer). Off ⇒ ingress rooms keep LiveKit's ~300s server default. |
| `linear.room_empty_timeout_seconds` | number | `86400` | `emptyTimeout` (seconds) applied to the pre-created persistent room. **Caveat:** LiveKit's `createRoom` only sets the timeout for a room that does **not yet exist** — it will not lower/raise an already-live room's timeout. |
| `linear.always_on_hls` | boolean | `false` | **QW-2**: a reconciliation watchdog relaunches a DEAD HLS egress for each of the app's active rooms (`HlsService.start` is idempotent, so a live egress is never double-launched). |
| `linear.dvr` | boolean | `false` | **QW-4**: the HLS egress also writes a bounded rolling `live.m3u8`, which StreamHub serves as the public manifest (so the live edge never grows unbounded), and the watchdog prunes old `.ts` beyond the window. Off ⇒ the full `index.m3u8` is served, unchanged. |
| `linear.dvr_window_seconds` | number | `3600` | **QW-4**: DVR retention window (seconds). Segments older than this are pruned from `<data>/apps/<app>/hls/<room>/` — never one still referenced by the live playlist. |
| `public_playback` | boolean | `true` | `false` makes the app **private**: the public play-token / listen-token need a signed URL (`?exp=&sig=`) and, since 3.4.0, `/hls/<app>/…` (playlists **and** segments, also under nginx/Caddy direct-serve) needs the `?st=` token — 403 otherwise. See [features/signed-hls.md](./features/signed-hls.md). |
| `hls_token_ttl_seconds` | number | `21600` | Lifetime (s) of the `?st=` HLS token of a private app, clamped to 60–86400. Set via `config.yaml`. |
| `geo` | object | absent (off) | **Geo-blocking** (3.4.0): `{allow: [AR, UY], deny: [], publish: false}` — ISO 3166-1 alpha-2 codes. A non-empty `allow` admits only those countries (an IP the base does not know is blocked); `deny` always wins. Applies to the public play/listen/HLS tokens and to `/hls`; `publish: true` extends it to the RTMP publishes of the MediaMTX passthrough front. LAN/loopback clients are never blocked. **Needs `STREAMHUB_GEOIP_DB`** (a local GeoLite2-Country/City `.mmdb`); without it the block is ignored and logged. See [features/signed-hls.md](./features/signed-hls.md#geo-blocking). |
| `play_auth` | object | absent (off) | **Play-auth webhook** (AntMedia `webhookPlayAuthUrl`, 3.4.0): `{webhook_url, timeout_ms: 3000, fail_open: false}`. Every anonymous playback grant (play/listen/HLS token) POSTs `play.authorize` to the URL (signed with `callbacks.secret`) and is granted only on a 2xx. Errors/timeouts deny unless `fail_open`. SSRF-guarded like callbacks. See [features/signed-hls.md](./features/signed-hls.md#play-auth-webhook). |
| `hls` | object | absent | **G5 — AMS `hlsTime`/`hlsListSize`.** Resolved into `AppConfig.features.hls` only when present. `segment_seconds` (int 1..30, default `4`) is the live HLS egress segment length (`hlsTime`). `list_size` (int 0..10000, default `0`) is `hlsListSize`: `> 0` makes the core serve `dvr.m3u8` = the last N segments of `index.m3u8` (a sliding window it rewrites on disk); `0` keeps the full `index.m3u8`. Ignored while `dvr.enabled` (the window is then derived). See [features/dvr-clips.md](./features/dvr-clips.md). |
| `dvr` | object | absent (off) | **G5 — DVR/timeshift.** `enabled` (bool, default `false`) + `window_minutes` (int 1..1440, default `60`). On: `POST/GET …/hls` hand out `…/dvr.m3u8` + `dvr: {windowSeconds, segmentSeconds}`, the window writer keeps it in step with `index.m3u8`, the watchdog keeps every active stream's egress up and prunes segments older than the window (+3 segments) never touching one referenced by `dvr.m3u8`. Players get seek / "Ir al vivo" / timeline and `?t=` (epoch or `-5m`). Wins over `linear.dvr`. See [features/dvr-clips.md](./features/dvr-clips.md). |
| `clips` | object | absent (off) | **G6 — clips.** `enabled` (bool, default `false`), `max_seconds` (1..600, default `120`), `max_concurrent` (1..8, default `2`), `max_queued` (1..200, default `20`). Gates `POST /apps/{app}/streams/{id}/clips` and Streamflow's `action.clip`; needs the room's HLS segments on disk (an HLS egress, or `dvr.enabled`) and an S3 bucket. See [features/dvr-clips.md](./features/dvr-clips.md). |
| `allowed_publisher_cidr` | string list | absent (anyone) | **3.4.0** (↔ AntMedia `allowedPublisherCIDR`). Source networks a publisher may come from: IPv4/IPv6 addresses or CIDRs (a bare IP is `/32`/`/128`; an AntMedia-style comma-separated string is also read). Enforced on (a) `POST /apps/{app}/tokens` when the token can publish — the **caller's** address must match, else **403** — and (b) RTMP/SRT pushes through the MediaMTX single-port `:1935` front (both the passthrough and the LiveKit plane), refused in the auth hook before any media flows. A push straight to the LiveKit ingress port (multi-port model) or to WHIP `:8080` never reaches the core, so it is **not** covered — firewall those ports. An entry that does not parse matches nothing (fail closed). Set with `PATCH /apps/{app}/config` (`features.allowedPublisherCidr`, ≤ 64 valid entries; `[]` = off). See [features/publisher-restrictions.md](./features/publisher-restrictions.md). |
| `max_bitrate_accept` | number (bits/s) | absent (no cap) | **3.4.0** (↔ AntMedia `maxBitrateAccept`). A LiveKit ingress (RTMP/WHIP/URL) whose measured input bitrate (video + audio, as LiveKit reports it) exceeds the cap is **cut**: its participant is removed (the stream key is kept; the encoder may reconnect and is checked again) and a `stream_ended` callback with `reason: "max_bitrate_exceeded"` is sent. **Reactive**, not an admission check: the ingress state is swept every 15 s (and checked on `ingress_started`). WebRTC publishers and passthrough remuxes are not measured. Set with `PATCH /apps/{app}/config` (`features.maxBitrateAccept`, integer ≥ 0; `0` = off). See [features/publisher-restrictions.md](./features/publisher-restrictions.md). |
| `drm` | object | disabled | **Encrypt the packaged VOD/HLS output** (CENC/CBCS CMAF via `shaka-packager` + an external key server). Default OFF → clear packaging, pipeline unchanged. Sub-keys: `enabled` (bool, default `false`), `provider` (`none`\|`external`), `systems` (subset of `widevine`/`playready`/`fairplay`, default all), `scheme` (`cbcs`\|`cenc`, default `cbcs`), `key_server_url`, `key_server_token_env` (a **ref**, never the token: empty = no token, otherwise exactly the server-derived `APP_<SLUG>_DRM_TOKEN`, whose value you store in `data/secrets.json`), `license_urls.{widevine,playready,fairplay}`, `fairplay_cert_url`, `fail_open` (default `false` = fail **closed**: no clear variant ships when encryption is impossible). No vendor keys ship — inert until a key server + `shaka-packager` are configured. Applies to packaged VOD only; WebRTC is protected by SRTP. Full detail in [features/DRM.md](./features/DRM.md). |

### How features surface in the API

- **`rtmp_password`** → `POST /apps/{app}/ingress` returns a `stream_password` alongside
  `url` + `streamKey`. Publish URL stays `rtmp://media.digitalhub.com.ar:1935/<prefix>/<key>`.
- **`viewer_counter`** → `GET /apps/{app}/streams/{id}` live-enriches `lastStatsJson`
  with `{ live, participants, publishers }`; viewers = subscribers (non-publishers,
  excluding hidden).
- **`chat` / `reactions`** → transported on LiveKit data channels (no REST endpoint);
  tokens are minted with `canPublishData: true`. Events forwarded as `chat_message` /
  `reaction` callbacks.
- **`hidden_qc`** → `POST /apps/{app}/tokens` accepts `hidden` + `recorder`, granting
  `hidden: true` / `roomRecord: true`. Hidden participants are skipped by the webhook
  stream upserts and excluded from viewer counts.
- **`adaptive_player`** → pairs with `webrtc.adaptive` / `rtmp.transcode` and the
  `transcoding/layers` ladder.
- **`linear`** → no dedicated REST endpoint; it changes existing flows for 24/7
  channels: `POST /apps/{app}/ingress` pre-creates the room (QW-1); the HLS
  watchdog relaunches dead egresses + prunes DVR segments on a timer (QW-2/QW-4);
  and `POST/GET /apps/{app}/streams/{id}/hls` serve `live.m3u8` (rolling) instead
  of `index.m3u8` when `dvr` is on. The watchdog can be disabled host-wide with
  `STREAMHUB_HLS_WATCHDOG=off` (cadence via `STREAMHUB_HLS_WATCHDOG_INTERVAL_S`,
  default 30s). Resolved values are visible on `GET /apps/{app}/config`.
- **`public_playback: false` / `hls_token_ttl_seconds` / `geo` / `play_auth`**
  (3.4.0) → `GET /apps/{app}/hls-token/{room}` mints the HLS token; the
  `playlistUrl` of `POST/GET /apps/{app}/streams/{id}/hls` and the sign
  endpoint's `hlsUrl` already carry it. The three new blocks are omitted from
  `GET /apps/{app}/config` (`features.hlsTokenTtlSeconds` / `geo` / `playAuth`)
  until set. See [features/signed-hls.md](./features/signed-hls.md).
- **`hls` / `dvr`** → change the existing HLS flows: the egress segment length,
  the served playlist (`dvr.m3u8` window) and, under `dvr`, always-on + pruning;
  `POST/GET /apps/{app}/streams/{id}/hls` return the `dvr.m3u8` URL and a `dvr`
  key. Public players probe `dvr.m3u8` and honour `?t=`.
- **`clips`** → `POST /apps/{app}/streams/{id}/clips`, `GET …/clips`,
  `GET /apps/{app}/clips[/{clipId}]` and the `clip.ready` / `clip.failed`
  callbacks; clip VODs carry `source: "clip"` (`GET /apps/{app}/vods?source=clip`).
- **`allowed_publisher_cidr` / `max_bitrate_accept`** → no dedicated endpoint:
  a publisher token from outside the list answers 403; a MediaMTX-front push
  from outside the list is refused (401 to MediaMTX); an ingress above the cap
  is cut with a `stream_ended` (`reason: "max_bitrate_exceeded"`, plus
  `bitrate` / `maxBitrateAccept`) callback. See
  [features/publisher-restrictions.md](./features/publisher-restrictions.md).
- **`drm`** → no REST endpoint; it changes the VOD post-transcode. When it
  encrypts, `vod_variants` gains a `master` row `format: hls-drm` + `rendition`
  rows `format: hls-cmaf-<scheme>`, and the `vod_variants_ready` callback +
  VOD metatags carry a public `drm` summary `{ scheme, systems, keyIds,
  licenseUrls }` — key **values** are never surfaced. See
  [features/DRM.md](./features/DRM.md).

---

## `variables`

Per-app **plain-config** key→value map, referenced from
[filename templates](#filename-templates-filename_template--snapshot_template) as
`${var.NAME}`. Resolved into `AppConfig.variables` and returned by
`GET /apps/{app}/config`.

| Aspect | Detail |
|--------|--------|
| Keys | must match `[A-Za-z0-9_]{1,64}` (usable inside a template) — other keys are dropped on resolve. |
| Values | strings, length-capped (512 chars). |
| CRUD | `PATCH /apps/{name}` with `variables` — a **whole-map REPLACE** (send the full desired set; a removed key is deleted). Also editable in the dashboard config screen (key/value editor). |
| Secrets | **NOT** for secrets — these are plain config and are returned by the config API. Use `data/secrets.json` (server-derived `*_env` refs) for credentials. |

```yaml
variables:
  site: HQ
  channel: main
# → filename_template: "${var.site}_${room}_${date:yyyyMMdd}" ⇒ HQ_lobby_20260713.mp4
```

## Notes

- The default app `live` is created at boot with this template.
- Editing the YAML directly on disk is possible, but the canonical path is the API
  (`PATCH /apps/{name}` and `PATCH /apps/{app}/config`), which keeps the in-memory
  config and DB consistent and re-resolves S3 credentials.
- Errors never crash the process; invalid config falls back to defaults where safe and is
  logged (queryable via `GET /logs`).
- **Plugin config is NOT part of `config.yaml`.** Each installed plugin keeps its own
  typed config in the per-app `app_plugins` table (validated against the plugin's
  `configSchema`), edited via `PATCH /apps/{app}/plugins/{id}` or the dashboard's
  Plugins tab — see [features/plugins.md](./features/plugins.md). The manifest also
  carries the **Studio-App taxonomy** (`kind: 'plugin'|'app'`, any `storage.db` the
  extension owns, and whether it is `exportable`) — that is manifest metadata, not
  config; the config still lives in `app_plugins`. See
  [features/STUDIO-APPS.md](./features/STUDIO-APPS.md). For example the
  **`scheduled-live`** player-overlay plugin exposes: `mode` (`cover`|`badge`, default
  `cover`), `accent` (hex, `#2f7bff`), `headline` (`The live stream starts soon`),
  `revealAnimation` (`fade`|`zoom`|`none`, `fade`), `muteUntilStart` (bool, `true`),
  `showViewerLocalTime` (bool, `true`), `autoHideAfterStartSec` (number 0–60, `5`). Its
  scheduled events (the agenda) live in the per-app `scheduled_events` table, managed
  via `/apps/{app}/scheduled-live` (`startAt` = absolute unix epoch ms, UTC).
- Another plugin-config example — the **`transcription`** processor plugin (VOD
  speech-to-text + SRT, see [features/plugins.md](./features/plugins.md#vod-transcription--speech-to-text--srt-for-recordings)):
  `provider` (`local`|`openai`, default `local` — local faster-whisper worker, no
  paid API), `model` (whisper size for local: `tiny`|`base`|`small`|`medium`|`large-v3`,
  default `small`), `openaiModel` (`whisper-1` default | `gpt-4o-transcribe` |
  `gpt-4o-mini-transcribe`), `language` (`auto`), `autoTranscribe` (bool, `true` —
  transcribe every VOD as soon as it is ready), `apiKey` (secret, only for
  `openai`), `device` (`auto`|`cpu`|`cuda`, local engine). Transcripts live in the
  per-app `vod_transcripts` table; the SRT is uploaded to the app's S3 next to the
  recording (`<fileKey minus .mp4>.srt`).
- The four **vision apps** (`occupancy` / `counting` / `crowd` / `demography` —
  the 2.16.0 split of the old `vision` app, see
  [features/vision-edge.md](./features/vision-edge.md)) each expose the shared
  knobs `device` (`cpu`|`cuda`, default `cpu`), `fps` (number, default `3.5`) and
  `confidence` (0–1, default `0.35`); `demography` also has `engine`
  (`local`|`openai`|`deepseek`, default `local`) and an `ai_api_key` secret (used
  only by an API engine, never sent to an edge node). The per-stream geometry
  (polygon zones / crossing lines / ROI) is **not** plugin config — it lives per
  room in each app's own `<model>.db` `stream_settings`, edited from the app tab's
  editor, not `app_plugins`. These apps are **edge-capable**: their assignments to
  edge nodes go through `POST /apps/:app/edge/assignments`, not `config.yaml`.
