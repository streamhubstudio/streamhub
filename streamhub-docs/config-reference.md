# StreamHub — `config.yaml` Reference (per app)

Every app has a `config.yaml` at `apps/<name>/config.yaml`. It is the versionable source
of truth for that tenant's behaviour. **S3 credentials never live here** — only `*_env`
references; the real values are resolved from the environment / `data/secrets.json`
(chmod 600).

When loaded by streamhub-core the YAML is parsed into an `AppConfig` object with the S3
credentials already resolved. The API exposes/edits it via:

- global `PATCH /apps/{name}` — displayName, roomPrefix, recording toggle, callbacks;
- per-app `GET/PATCH /apps/{app}/config` — adaptive/transcoding (webrtc layers, rtmp
  transcode);
- per-app **presets** `GET /apps/{app}/presets` + `POST /apps/{app}/presets/{name}/apply`
  — apply a delivery/quality profile (`low-latency` / `high-quality-recording` /
  `mass-audience-HLS`) as a credential-safe deep-merge + hot-reload. See
  [features/presets.md](./features/presets.md).

See [api-global.md](./api-global.md) and [api-app.md](./api-app.md).

---

## Full example

```yaml
name: live
display_name: Live
room_prefix: live

recording:
  enabled: true
  mode: room-composite          # room-composite | participant
  layout: grid
  local_dir: recordings
  delete_local_after_upload: true

s3:
  provider: wasabi              # aws | wasabi | minio
  bucket: ale-backup
  region: us-east-1
  endpoint: https://s3.us-east-1.wasabisys.com   # empty for plain AWS
  force_path_style: false       # true for minio (path-style)
  prefix: streamhub/live
  access_key_env: APP_LIVE_S3_KEY      # credential REFERENCES, not values
  secret_key_env: APP_LIVE_S3_SECRET

webrtc:
  adaptive: true
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
# password NEVER lives here — only the `password_env` REFERENCE; the value is
# resolved from the environment / data/secrets.json (like the S3 credentials).
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

# Stream latency/health alerting: emits stream.latency_high /
# stream.latency_recovered through BOTH callbacks and MQTT.
latency_alert:
  enabled: false
  threshold_ms: 1000            # probe-RTT breach threshold
  cooldown_seconds: 60          # min seconds between alerts per room
  interval_seconds: 10          # sampling interval

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
```

---

## Top-level

| Key | Type | Default | Notes |
|-----|------|---------|-------|
| `name` | string | — | App slug (unique). Matches `apps.name`. |
| `display_name` | string | `name` | Human label. Editable via `PATCH /apps/{name}`. |
| `room_prefix` | string | `name` | LiveKit room namespace. Rooms become `<prefix>` or `<prefix>-<room>`. |

Maps to `AppConfig.name` / `displayName` / `roomPrefix`.

## `recording`

| Key | Type | Default | Notes |
|-----|------|---------|-------|
| `enabled` | boolean | `true` | Toggle recording for the app (also via `recordingEnabled` in `PATCH /apps/{name}`). |
| `mode` | `room-composite` \| `participant` | `room-composite` | Composite of the whole room, or a single participant. Used by `POST /recording/start`. |
| `layout` | string | `grid` | Egress composite layout (e.g. `grid`, `speaker`). |
| `local_dir` | string | `recordings` | Subdir under `apps/<name>/` for temp MP4s before upload. |
| `delete_local_after_upload` | boolean | `true` | Delete the local file once the S3 upload succeeds. |

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
| `access_key_env` | string | — | **Name of the env var** holding the access key. |
| `secret_key_env` | string | — | **Name of the env var** holding the secret key. |

> Security: only the `*_env` reference names are stored in `config.yaml`. The actual
> access/secret keys are read from the environment or `data/secrets.json` (chmod 600) and
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
| `adaptive` | boolean | `true` | Enable adaptive (simulcast) WebRTC delivery. |
| `layers` | list of `{ name, height }` | `[{high,720},{med,480},{low,240}]` | Rendition ladder. `name` is a short slug; `height` 1..4320 (width derived by LiveKit from the source aspect). 1..8 entries; a PATCH `layers` replaces the whole ladder. |

## `rtmp`

| Key | Type | Default | Notes |
|-----|------|---------|-------|
| `enabled` | boolean | `true` | Allow RTMP ingress for the app. |
| `transcode` | boolean | `true` | Sub-preference for `enableTranscoding` on RTMP/URL ingress (multi-layer). **Only takes effect when `transcoding.enabled` is true** — with the master switch off, ingress is always passthrough. |

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
| `url` | string | `""` | Broker URL: `mqtt://`, `mqtts://`, `ws://` or `wss://` (path allowed, e.g. `wss://mqtt.example.com/mqtt`). Empty = off. |
| `username` | string | `""` | Broker username (empty for anonymous brokers). |
| `password_env` | string | `APP_<SLUG>_MQTT_PASSWORD` | **Name of the env var / secrets.json key** holding the broker password. The value is set via `PUT /apps/{app}/mqtt` (`password`) and NEVER stored in the yaml; on reads it is masked (like the S3 credentials). |
| `topic_prefix` | string | `streamhub/<app>` | Topic root. Messages go to `<prefix>/<category>/<event>` (see features/mqtt.md for the category map). |
| `qos` | `0` \| `1` \| `2` | `0` | Publish QoS for every message. |
| `tls` | boolean | `false` | Force TLS: `mqtt://` is upgraded to `mqtts://` (and `ws://` to `wss://`) before connecting. `mqtts://`/`wss://` URLs already use TLS regardless. |
| `events` | list | `[all]` | Event filter: `all` (whole taxonomy) or an explicit list of event names (e.g. `[vod_ready, stream.latency_high]`). |
| `logs.enabled` | boolean | `false` | Forward the app's log stream to `<prefix>/log/<level>`. |
| `logs.level` | level | `info` | Minimum forwarded level (`trace|debug|info|warn|error|fatal`). |

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
| `ws_ingest` | object | enabled | Direct WebSocket MJPEG ingest for ESP32-CAM class devices (`wss://<domain>/ingest/ws` — see [integrations/ESP32-WS-INGEST.md](./integrations/ESP32-WS-INGEST.md)). Sub-keys: `enabled` (bool, default `true`), `max_cameras` (int, `0` = unlimited), `max_fps` (int, default `15` — excess frames dropped server-side), `max_frame_kb` (int, default `256` — a bigger frame closes with 4413). |

### How features surface in the API

- **`rtmp_password`** → `POST /apps/{app}/ingress` returns a `stream_password` alongside
  `url` + `streamKey`. Publish URL stays `rtmp://media.example.com:1935/<prefix>/<key>`.
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

---

## Notes

- The default app `live` is created at boot with this template.
- Editing the YAML directly on disk is possible, but the canonical path is the API
  (`PATCH /apps/{name}` and `PATCH /apps/{app}/config`), which keeps the in-memory
  config and DB consistent and re-resolves S3 credentials.
- Errors never crash the process; invalid config falls back to defaults where safe and is
  logged (queryable via `GET /logs`).
