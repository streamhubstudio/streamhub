# StreamHub — Webhooks & Callbacks

Two directions:

1. **Incoming** — LiveKit → StreamHub: the egress/ingress/participant events StreamHub
   consumes to keep `streams`/`vods` in sync and to trigger jobs and outbound callbacks.
2. **Outbound** — StreamHub → your app: signed POSTs to the per-app callback URL on
   stream/VOD (and chat/reaction) events.

---

## Incoming: LiveKit webhook

### POST /api/v1/webhooks/livekit

The sink for LiveKit server webhooks. **Public route** (no Bearer token): authenticity is
verified by the **LiveKit signature** in the `Authorization` header, validated with the
SDK `WebhookReceiver` against the **raw request body** (so the exact signed bytes are
checked). Configure this URL in your LiveKit server's `webhook.urls`.

- This route is excluded from the OpenAPI docs (internal).
- **Always acks `200`** with `{ "data": { "received": true } }` once the signature is
  valid — downstream handler errors are logged but never cause a non-200 (prevents
  LiveKit retry storms and never crashes the process).
- A **bad/missing signature** returns `401 Unauthorized`.

**Headers**

| Header | Notes |
|--------|-------|
| `Authorization` | LiveKit-issued JWT signing the body (verified by `WebhookReceiver`) |
| `Content-Type` | `application/webhook+json` (LiveKit default) |

**Response 200**

```json
{ "data": { "received": true } }
```

### Events handled

The `room` name on the event is mapped back to a StreamHub app via the longest matching
`livekitRoomPrefix`. Then:

| LiveKit event | StreamHub action |
|---------------|----------------|
| `egress_started` / `egress_updated` / `egress_ended` | Forwarded to the recording service (`onEgressEvent`) to advance the recording flow (upload, VOD finalize). |
| `ingress_started` | Upsert a `streams` row (type from input: RTMP→`rtmp`, WHIP→`whip`, URL→`rtsp`); dispatch outbound `stream_started`. |
| `ingress_ended` | Dispatch outbound `stream_ended`. |
| `participant_joined` | Upsert a `webrtc` stream row; dispatch `stream_started`. **Hidden QC/recorder participants are skipped** (not a real stream, not counted). |
| `participant_left` | Dispatch `stream_ended` (hidden participants skipped). |
| `room_started` / `room_finished` / `track_*` | No-op (logged only). |

Every dispatch is wrapped defensively: a downstream failure is logged (source
`livekit-webhook`) and the webhook still acks 200.

### Recording flow

How an egress becomes a finished VOD (SPEC §8):

1. `POST /apps/{app}/recording/start` → StreamHub starts an egress
   (`room-composite` | `participant` per the app config) writing to a local file
   `apps/{app}/recordings/<stream>-<ts>.mp4`, and inserts a VOD row `status=recording`.
2. LiveKit `egress_updated` / `egress_ended` → `onEgressEvent` marks `status=uploading`
   and enqueues the upload job.
3. Job: upload the local file to the app's S3 (`prefix/<file>`) → derive `publicUrl`
   (presigned or public) → delete the local file (if `recording.delete_local_after_upload`)
   → generate + upload a snapshot (ffmpeg frame) → set `status=ready`, persist metatags
   (room, app, duration, resolution, codec) in `vods.db` → fire outbound **`vod_ready`**.
4. On upload failure: `status=failed`, the local file is **kept**, the error is logged,
   and outbound **`recording_failed`** fires.

---

## Outbound: app callbacks

When `callbacks.url` is set on an app's config (and optionally `callbacks.secret`),
StreamHub POSTs a signed JSON envelope to that URL on events.

### Delivery & signing

- **Method/Body**: `POST` with `Content-Type: application/json`.
- **Envelope**:

  ```json
  {
    "id": "f2b1c8e4-...",          // unique delivery id (UUID)
    "event": "vod_ready",          // event name
    "app": "live",                 // app name
    "timestamp": "2026-06-30T12:00:00.000Z",
    "data": { /* event-specific payload */ }
  }
  ```

- **Headers**:

  | Header | Value |
  |--------|-------|
  | `User-Agent` | `streamhub-core/callbacks` |
  | `X-StreamHub-Event` | the event name |
  | `X-StreamHub-Delivery` | the delivery `id` (UUID) |
  | `X-StreamHub-Timestamp` | ISO-8601 emission time |
  | `X-StreamHub-Signature` | `sha256=<hex>` = HMAC-SHA256(`callbacks.secret`, rawBody) — only when a secret is set |

- **Verify the signature** (compute HMAC-SHA256 of the exact received body with the shared
  secret, compare to the hex after `sha256=`):

  ```js
  const crypto = require('crypto');
  const expected = 'sha256=' + crypto
    .createHmac('sha256', SECRET)
    .update(rawBody)            // the exact bytes received
    .digest('hex');
  const ok = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(req.header('X-StreamHub-Signature')));
  ```

- **Retries**: up to **3 attempts** with exponential backoff (500ms, 1s) and a 10s
  per-request timeout. `5xx`, `408`, `429` are retried; other `4xx` are treated as a
  rejection and not retried. Respond `2xx` to acknowledge. Callbacks never throw back into
  the StreamHub flow.

### Events

#### `stream_started`

A publisher/ingress went live.

```json
{
  "id": "…", "event": "stream_started", "app": "live",
  "timestamp": "2026-06-30T12:00:00.000Z",
  "data": {
    "streamId": "live-demo/camera-1",
    "room": "live-demo",
    "type": "webrtc",
    "participant": "camera-1"
  }
}
```

For ingress-driven streams, `type` is `rtmp` | `whip` | `rtsp` and `streamId` is the
ingress id; `participant` may be absent.

#### `stream_ended`

A publisher/ingress stopped.

```json
{
  "id": "…", "event": "stream_ended", "app": "live",
  "timestamp": "2026-06-30T12:01:30.000Z",
  "data": { "streamId": "live-demo/camera-1", "room": "live-demo", "participant": "camera-1" }
}
```

#### `vod_ready`

A recording finished uploading and is playable.

```json
{
  "id": "…", "event": "vod_ready", "app": "live",
  "timestamp": "2026-06-30T12:02:30.000Z",
  "data": {
    "vodId": 12,
    "app": "live",
    "room": "live-demo",
    "streamId": "cam-42",
    "fileKey": "streamhub/live/live-demo-2026-06-30.mp4",
    "s3Url": "https://s3.us-east-1.wasabisys.com/ale-backup/streamhub/live/live-demo-2026-06-30.mp4",
    "publicUrl": "https://.../presigned-or-public",
    "snapshotKey": "streamhub/live/snapshots/live-demo-2026-06-30.jpg",
    "sizeBytes": 10485760,
    "durationS": 120,
    "width": 1280,
    "height": 720,
    "format": "mp4"
  }
}
```

#### `recording_failed`

The upload/finalize step failed; the local file is kept.

```json
{
  "id": "…", "event": "recording_failed", "app": "live",
  "timestamp": "2026-06-30T12:02:30.000Z",
  "data": {
    "vodId": 12,
    "app": "live",
    "room": "live-demo",
    "streamId": "cam-42",
    "reason": "s3 upload failed",
    "detail": "AccessDenied: ..."
  }
}
```

#### `chat_message` (wave-2, `features.chat`)

Fired when a chat message/emoji is observed on the `chat` data-channel topic. Enabled per
app via `features.chat`. Carries the room, sender identity and the message.

```json
{
  "id": "…", "event": "chat_message", "app": "live",
  "timestamp": "2026-06-30T12:03:00.000Z",
  "data": {
    "room": "live-demo",
    "from": "user-123",
    "message": "hello 👋",
    "ts": "2026-06-30T12:03:00.000Z"
  }
}
```

#### `reaction` (wave-2, `features.reactions`)

Fired when an animated reaction is observed on the `reaction` topic. Enabled via
`features.reactions`.

```json
{
  "id": "…", "event": "reaction", "app": "live",
  "timestamp": "2026-06-30T12:03:05.000Z",
  "data": {
    "room": "live-demo",
    "from": "user-123",
    "reaction": "heart"
  }
}
```

#### `plugin_worker_started` / `plugin_worker_stopped` / `plugin_worker_error`

Fired by the plugins-framework worker hook when a per-app plugin worker process
starts, exits cleanly (or is stopped) or errors/crashes.

```json
{
  "id": "…", "event": "plugin_worker_error", "app": "live",
  "timestamp": "2026-07-03T12:04:00.000Z",
  "data": { "plugin": "yolo", "exitCode": 1, "signal": null }
}
```

`data` carries `plugin` plus `pid` (started), `exitCode`+`signal` (stopped/crash)
or `error` (spawn/process error).

#### `stream.latency_high` / `stream.latency_recovered`

Fired by the per-app latency monitor (`latency_alert:` config block) when a live
room's sampled probe RTT crosses / recovers from the configured threshold. See
[features/mqtt.md](features/mqtt.md#high-latency-alert) for the metric.

```json
{
  "id": "…", "event": "stream.latency_high", "app": "live",
  "timestamp": "2026-07-03T12:05:00.000Z",
  "data": {
    "room": "live-demo",
    "rttMs": 2380,
    "thresholdMs": 1000,
    "metric": "livekit_room_probe_rtt_ms",
    "participants": 12,
    "publishers": 1
  }
}
```

> Implementation note: the canonical, code-backed outbound events today are
> `stream_started`, `stream_ended`, `vod_ready` and `recording_failed` (shared signing/
> envelope/retry path). `chat_message` and `reaction` are the SPEC §16 contract emitted
> when the chat/reaction data-channel features are enabled; they use the **same envelope,
> headers and HMAC signature** described above.

> **MQTT mirror**: every outbound event on this page is ALSO published to the app's
> MQTT broker when the per-app `mqtt:` block is enabled — same taxonomy and `data`
> payload, envelope `{event, app, timestamp, data}`, topics
> `<topic_prefix>/<category>/<event>`. See [features/mqtt.md](features/mqtt.md).

### Receiver example

```js
// Express
app.post('/streamhub', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.header('X-StreamHub-Signature');
  const expected = 'sha256=' + crypto.createHmac('sha256', SECRET).update(req.body).digest('hex');
  if (!sig || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return res.status(401).end();
  }
  const evt = JSON.parse(req.body.toString('utf8'));
  switch (evt.event) {
    case 'vod_ready': /* ... */ break;
    case 'stream_started': /* ... */ break;
    // ...
  }
  res.status(200).end();
});
```
