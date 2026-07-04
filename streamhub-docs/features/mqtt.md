# MQTT (per-app event publishing + high-latency alerts)

## What it does

Per app, StreamHub publishes **every event notification over MQTT in addition to
the existing signed webhooks** ([callbacks.md](./callbacks.md)):

- **Connection events** — `stream_started`/`stream_ended`, `participant_joined`/
  `participant_left`, `room_*`, `track_*`, `ingress_started`/`ingress_ended`,
  `hls_*`, `restream_*`.
- **VOD / recording status** — `recording_started`, `recording_part_ready`,
  `recording_ready`, `recording_failed`, `vod_ready`, `vod_variants_ready`,
  `snapshot_taken`, `egress_*`.
- **Plugin events** — `plugin_worker_started`, `plugin_worker_stopped`,
  `plugin_worker_error` (the plugins-framework worker hook).
- **Alerts** — `stream.latency_high` / `stream.latency_recovered` (see below).
- **App logs** (optional) — the app's structured log stream at a configurable
  minimum level.

The implementation is a **single tap** on the callbacks dispatcher (the one
funnel every outbound event already flows through), so webhooks and MQTT always
see exactly the same taxonomy — there are no duplicated emit sites. MQTT
publishing works even when no webhook URL is configured (an app may be
MQTT-only), and a broker outage can never break the emitting flow (best-effort,
never-throws, same contract as callbacks).

## Configuration

Config.yaml block (per app) — full reference in
[config-reference.md](../config-reference.md#mqtt):

```yaml
mqtt:
  enabled: false
  url: ""                      # mqtt:// | mqtts:// | ws:// | wss:// (path ok)
  username: ""
  password_env: APP_LIVE_MQTT_PASSWORD   # REFERENCE — value in secrets.json/env
  topic_prefix: streamhub/live
  qos: 0                       # 0 | 1 | 2
  tls: false                   # force mqtt:// → mqtts:// (ws:// → wss://)
  events: [all]                # or an explicit list of event names
  logs:
    enabled: false
    level: info

latency_alert:
  enabled: false
  threshold_ms: 1000
  cooldown_seconds: 60
  interval_seconds: 10        # min 2
```

API: `GET /apps/{app}/mqtt` (password **masked**, like the S3 credentials) and
`PUT /apps/{app}/mqtt` (partial update; omit `password` to keep the stored
one). The dashboard exposes the same fields in **App → Integraciones → MQTT**.
The read response also carries `configured` (a broker `url` is set) and
`hasPassword` (a password is currently stored) alongside the masked
`password`/`passwordEnv`, so a client can render connection state without
ever seeing the secret.

> **Security** — the broker password NEVER lands in `config.yaml`: the yaml only
> carries the `password_env` reference and the value is persisted to
> `data/secrets.json` (chmod 600) / read from the environment, exactly like the
> per-app S3 credentials. Config reads (GET /mqtt, PATCH /apps/{name}) return it
> masked. An inline `mqtt.password` in the raw YAML editor is ignored with a
> warning.

Supported broker URLs: `mqtt://host:1883`, `mqtts://host:8883`,
`ws://host:8083/mqtt`, `wss://mqtt.example.com/mqtt` (TLS-terminating
reverse proxy with a path — the production shape). MQTT 3.1.1/5 via the `mqtt`
npm client; keepalive 60 s; clean sessions; auto-reconnect with incremental
backoff (1 s → 2 s → 4 s … capped at 30 s, reset on connect). Clients are
created lazily on the first publish and cleanly disconnected on config change,
hot-reload and app delete.

## Topics & envelope

**StreamHub defines the topic convention** (the broker imposes none):

```
<topic_prefix>/<category>/<event>     e.g. streamhub/live/vod/vod_ready
<topic_prefix>/log/<level>            e.g. streamhub/live/log/error
```

| Category | Events |
|----------|--------|
| `connection` | `room_*`, `participant_*`, `track_*`, `ingress_*`, `stream_started/ended`, `hls_*`, `restream_*` |
| `vod` | `recording_*`, `vod_*`, `snapshot_taken`, `egress_*` |
| `plugin` | `plugin_worker_started`, `plugin_worker_stopped`, `plugin_worker_error` |
| `interaction` | `chat_message`, `reaction` |
| `alert` | `stream.latency_high`, `stream.latency_recovered` |
| `log` | forwarded app log lines (`event: "log"`) |

Every message is a JSON envelope (`retain: false`, QoS from config):

```json
{
  "event": "stream_started",
  "app": "live",
  "timestamp": "2026-07-03T12:00:00.000Z",
  "data": { "room": "live-1", "streamId": "live-1/publisher", "type": "rtmp" }
}
```

`data` carries the same event-specific payload the webhook envelope carries in
its `data` field. Log lines use `event: "log"` and
`data: { level, source, message, meta? }`.

Subscribe examples:

```
streamhub/live/#                  everything for app "live"
streamhub/live/vod/#              VOD/recording pipeline only
streamhub/live/alert/#            latency alerts only
streamhub/live/log/error          error logs only
```

## App log forwarding

When `mqtt.logs.enabled` is true, every log line **attributed to the app**
(the same lines you see in `GET /apps/{app}/logs`) at or above `mqtt.logs.level`
is published to `<prefix>/log/<level>`. Lines emitted by the mqtt module itself
are excluded (loop guard). Plugin worker stdout/stderr is included (source
`plugin:<id>`), so a worker's output can be followed over MQTT too.

## High-latency alert

Config: `latency_alert: { enabled, threshold_ms, cooldown_seconds,
interval_seconds }` (`interval_seconds` has a floor of **2s**, enforced both by
the API and the monitor). When enabled, the monitor samples every **active
room** of the app each `interval_seconds` and applies a latched threshold per
room:

- sample above `threshold_ms` → emit **`stream.latency_high`** (once — latched
  while it stays high) with payload
  `{ room, rttMs, thresholdMs, metric, participants, publishers }`;
- sample back at/below the threshold → emit **`stream.latency_recovered`**
  with payload `{ room, rttMs, thresholdMs, metric }` (no `participants`/
  `publishers` — those are only attached to the `_high` alert);
- a re-breach within `cooldown_seconds` of the previous alert is suppressed.

Both events go through the callbacks dispatcher, i.e. they reach the app's
**webhook AND MQTT** (`<prefix>/alert/...`) with the same payload.

### The metric — `livekit_room_probe_rtt_ms`, and why

Each sample times a **LiveKit server API round-trip scoped to the room**
(`RoomServiceClient.listParticipants(room)`) from the core. That RTT is the
alert metric.

Why this metric (and not per-viewer WebRTC RTT):

- **It is actually available.** The LiveKit server API does not expose
  per-participant RTT/jitter to the management layer; connection quality lives
  client-side. The core's real-time view of a stream is exactly its server API
  + webhooks — this probe measures that path with zero new infrastructure.
- **It degrades with the right failure modes.** In a self-hosted single-box or
  small-cluster deployment (StreamHub's shape), end-to-end latency creep is
  dominated by SFU/host overload (CPU saturation from transcoding/egress, event
  loop stalls, network pressure). Those same conditions inflate the SFU's API
  response time, so the probe RTT is a faithful early-warning proxy: a
  `listParticipants` that takes >1 s on a LAN/localhost link means the media
  server is in trouble *now*.
- **It is per-room and cheap.** One tiny API call per active room per interval
  (capped at 25 rooms/app/pass) — safe to run continuously; the same call also
  yields `participants`/`publishers`, which are attached to the alert payload
  for context.

Failed probes (room gone, LiveKit restarting) are skipped — they never flip the
alert state, so a LiveKit restart doesn't fire spurious `recovered` events. If
richer signals become available later (e.g. ingress bitrate history), they can
plug into the same monitor/probe seam without changing the event contract.

## Failure semantics

- `enabled: false` or empty `url` → no client is created, nothing is published,
  any live client is cleanly closed.
- Broker down → the client buffers/reconnects with backoff; QoS 0 messages
  emitted while disconnected are dropped (fire-and-forget), QoS 1/2 are queued
  by the client. Delivery over MQTT is **best-effort** — the webhook pipeline
  (with its retries) remains the at-least-once channel.
- Config change (`PUT /apps/{app}/mqtt`, raw editor + hot-reload) → the app's
  client is dropped and the next publish reconnects with the new settings.
- App delete → client closed immediately.
