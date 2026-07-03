# StreamHub — Per-App API

Endpoints scoped to a single app, under `/api/v1/apps/{app}/...`. Global (server-wide)
endpoints are in [api-global.md](./api-global.md).

- `{app}` is the app **name** (slug), e.g. `live`.
- All endpoints require `Authorization: Bearer <token>` (see
  [api-global.md](./api-global.md#authentication)).
- **Room namespacing**: a requested `room` is namespaced under the app's room prefix.
  If `room` is omitted it defaults to the app prefix; if provided and not already
  prefixed, it becomes `<prefix>-<room>`. So app `live` (prefix `live`) + `room=demo`
  → LiveKit room `live-demo`.
- Most per-app endpoints wrap their payload in `{ "data": ..., "error": null }`.

| Method | Path | Summary |
|--------|------|---------|
| POST | `/apps/{app}/tokens` | Mint a LiveKit join token (+ player/iframe URLs) |
| POST | `/apps/{app}/ingress` | Create RTMP / WHIP / URL ingress |
| GET | `/apps/{app}/ingress` | List ingresses for the app |
| GET | `/apps/{app}/ingress/{id}` | Get one ingress |
| DELETE | `/apps/{app}/ingress/{id}` | Delete an ingress |
| POST | `/apps/{app}/recording/start` | Start a recording (egress) |
| POST | `/apps/{app}/recording/{id}/stop` | Stop a recording |
| GET | `/apps/{app}/vods` | List VODs (filters + total + paging) |
| GET | `/apps/{app}/vods/{id}` | VOD detail with fresh presigned URL |
| GET | `/apps/{app}/vods/{id}/download` | Download URL (S3 attachment or local /raw) |
| GET | `/apps/{app}/vods/{id}/raw` | Stream a local VOD file as an attachment |
| DELETE | `/apps/{app}/vods/{id}` | Delete a VOD |
| GET | `/apps/{app}/stats` | Per-app stats (live/vods/storage/ingress/logs) |
| GET | `/apps/{app}/streams` | List active streams |
| GET | `/apps/{app}/streams/{id}` | Stream detail (with live viewer count) |
| DELETE | `/apps/{app}/streams/{id}` | Stop a stream |
| POST | `/apps/{app}/snapshots` | On-demand snapshot |
| GET | `/apps/{app}/config` | Get adaptive/transcoding config |
| PATCH | `/apps/{app}/config` | Patch adaptive/transcoding config |
| GET | `/apps/{app}/transcoding/layers` | Effective WebRTC rendition ladder |
| GET | `/apps/{app}/logs` | List logs attributed to this app |

For chat/reactions/viewers (data channels), see
[Data / Chat / Reactions](#data--chat--reactions) below and
[webhooks.md](./webhooks.md).

---

## Tokens

### POST /apps/{app}/tokens

Mint a LiveKit join token for a room of the app, plus the public player/iframe URLs.

**Body** (`MintTokenDto`) — all fields optional:

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `room` | string | app prefix | ≤ 120, chars `[a-zA-Z0-9._-]`; namespaced under app prefix |
| `identity` | string | random `anon-<uuid>` | participant identity, ≤ 120 |
| `name` | string | — | display name, ≤ 120 |
| `canPublish` | boolean | `true` | allow publishing media |
| `canSubscribe` | boolean | `true` | allow subscribing |
| `ttl` | string | `"6h"` | token TTL, e.g. `"10m"`, `"1h"` |
| `metadata` | string | — | opaque participant metadata, ≤ 2000 |
| `hidden` | boolean | `false` | **QC/recorder**: subscribes to all media but is invisible and not counted as a viewer (SPEC §16) |
| `recorder` | boolean | `false` | recorder/QC grant (`roomRecord`); pairs with `hidden` |

The minted grant also sets `canPublishData: true` so the client can use chat/reaction
data channels.

**Response 200**

```json
{
  "data": {
    "token": "<jwt>",
    "app": "live",
    "room": "live-demo",
    "identity": "user-123",
    "wsUrl": "wss://media.example.com",
    "playUrl": "https://streamhub.example.com/play/live/live-demo",
    "embedUrl": "https://streamhub.example.com/embed/live/live-demo",
    "iframe": "<iframe src=\"https://streamhub.example.com/embed/live/live-demo\" width=\"640\" height=\"360\" frameborder=\"0\" allow=\"autoplay; fullscreen; camera; microphone\" allowfullscreen></iframe>"
  }
}
```

`playUrl`/`embedUrl` are absolute when `PUBLIC_BASE_URL` is configured, otherwise relative
paths. `wsUrl` is the public LiveKit WSS the client connects to.

**curl** (a viewer / subscribe-only token):

```bash
curl -s -X POST https://streamhub.example.com/api/v1/apps/live/tokens \
  -H "Authorization: Bearer $STREAMHUB_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"room":"demo","identity":"viewer-1","canPublish":false,"ttl":"10m"}'
```

**curl** (a hidden QC/recorder token):

```bash
curl -s -X POST https://streamhub.example.com/api/v1/apps/live/tokens \
  -H "Authorization: Bearer $STREAMHUB_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"room":"demo","identity":"qc-1","hidden":true,"recorder":true,"canPublish":false}'
```

---

## Ingress (RTMP / RTSP / WHIP)

### POST /apps/{app}/ingress

Create an ingress that feeds a LiveKit room of the app.

**Body** (`CreateIngressDto`)

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `inputType` | `rtmp` \| `whip` \| `url` | yes | `rtmp` = push URL+key; `whip` = WHIP endpoint; `url` = pull source (RTSP/HLS) |
| `room` | string | no | dest room (namespaced); defaults to app prefix |
| `participantIdentity` | string | no | defaults to `ingress-<app>` / generated id |
| `participantName` | string | no | display name |
| `url` | string | when `inputType=url` | remote source to pull, e.g. `rtsp://camera.local/stream` |
| `enableTranscoding` | boolean | no | multi-layer transcoding; defaults from app `transcoding.enabled` **and** `rtmp.transcode` (new apps: off = passthrough) |

> **RTSP** is supported through `inputType: url` with an `rtsp://...` source (URL pull /
> relay → LiveKit), mapped internally to the URL input.

**Response 200** (`IngressInfo`)

```json
{
  "data": {
    "ingressId": "IN_abc123",
    "url": "rtmp://media.example.com:1935/live",
    "streamKey": "sk-9f3c...",
    "roomName": "live-demo"
  }
}
```

For RTMP, the publish endpoint is `url` + `streamKey`:
`rtmp://media.example.com:1935/live/<streamKey>`. The host is rewritten to
`RTMP_PUBLIC_HOST`. WHIP/URL ingresses return the WHIP endpoint / no stream key.

> **Wave-2 (SPEC §16)**: when `features.rtmp_password` is enabled for the app, the
> ingress additionally surfaces a `stream_password` that must accompany the push. See
> [config-reference.md](./config-reference.md#features-spec-16).

**curl** (RTMP):

```bash
curl -s -X POST https://streamhub.example.com/api/v1/apps/live/ingress \
  -H "Authorization: Bearer $STREAMHUB_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"inputType":"rtmp","room":"demo","enableTranscoding":true}'
```

**curl** (RTSP pull):

```bash
curl -s -X POST https://streamhub.example.com/api/v1/apps/live/ingress \
  -H "Authorization: Bearer $STREAMHUB_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"inputType":"url","room":"cam","url":"rtsp://camera.local/stream"}'
```

Then push with ffmpeg (RTMP example):

```bash
ffmpeg -re -i input.mp4 -c:v libx264 -c:a aac \
  -f flv "rtmp://media.example.com:1935/live/<streamKey>"
```

### GET /apps/{app}/ingress

List the app's ingresses (filtered to rooms belonging to the app prefix).

**Response 200**: `{ "data": [ IngressInfo, ... ] }`.

```bash
curl -s https://streamhub.example.com/api/v1/apps/live/ingress \
  -H "Authorization: Bearer $STREAMHUB_TOKEN"
```

### GET /apps/{app}/ingress/{id}

Get one ingress by id. **404** if not found.

**Response 200**: `{ "data": IngressInfo }`.

```bash
curl -s https://streamhub.example.com/api/v1/apps/live/ingress/IN_abc123 \
  -H "Authorization: Bearer $STREAMHUB_TOKEN"
```

### DELETE /apps/{app}/ingress/{id}

Delete an ingress.

**Response 200**

```json
{ "data": { "ingressId": "IN_abc123", "deleted": true } }
```

```bash
curl -s -X DELETE https://streamhub.example.com/api/v1/apps/live/ingress/IN_abc123 \
  -H "Authorization: Bearer $STREAMHUB_TOKEN"
```

---

## Recording

The recording **mode** (`room-composite` | `participant`) and `layout` come from the
app's `config.yaml`, not the request. See the full recording flow in
[webhooks.md](./webhooks.md#recording-flow) and the config in
[config-reference.md](./config-reference.md).

### POST /apps/{app}/recording/start

Start an egress recording for a room.

**Body** (`StartRecordingDto`)

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `roomName` | string | yes | LiveKit room to record (≤ 200) |
| `streamId` | string | no | logical stream id; in `participant` mode also used as the participant identity to egress |

**Response 200** (`RecordingHandle`)

```json
{ "data": { "vodId": 12, "egressId": "EG_xyz789", "status": "recording" }, "error": null }
```

A VOD row is inserted immediately with `status=recording`.

```bash
curl -s -X POST https://streamhub.example.com/api/v1/apps/live/recording/start \
  -H "Authorization: Bearer $STREAMHUB_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"roomName":"live-demo"}'
```

### POST /apps/{app}/recording/{id}/stop

Stop an in-progress recording. `{id}` may be the **VOD id** (numeric) or the **egress id**.

**Response 200** (`RecordingHandle`)

```json
{ "data": { "vodId": 12, "egressId": "EG_xyz789", "status": "uploading" }, "error": null }
```

```bash
curl -s -X POST https://streamhub.example.com/api/v1/apps/live/recording/12/stop \
  -H "Authorization: Bearer $STREAMHUB_TOKEN"
```

---

## VODs

### GET /apps/{app}/vods

List the app's VODs with filters, ordering, paging and a total count.

**Query** (all optional):

| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `room` | string | — | Exact room filter. |
| `status` | enum | — | `recording \| uploading \| ready \| failed`. |
| `since` | ISO-8601 | — | `started_at >=` (inclusive). |
| `until` | ISO-8601 | — | `started_at <=` (inclusive). |
| `order` | enum | `id` | Sort column: `started_at \| size_bytes \| id`. |
| `dir` | enum | `desc` | `asc \| desc`. |
| `all` | `1` | — | Return **every** matching row (ignores `limit`/`offset`). |
| `limit` | int | 200 | Clamped to 1..1000. |
| `offset` | int | 0 | Clamped to >= 0. |

Filters are AND-combined and backed by the `idx_vods_room` / `idx_vods_started_at` /
`idx_vods_status_started` indices. Default order is `id DESC` (newest first).

**Response 200** — the envelope now also carries `total` (count of the **filtered**
set), `limit` and `offset` alongside `data` (back-compatible: `data`/`error`
unchanged). With `all=1`, `limit` echoes the returned row count and `offset` is 0.

```json
{
  "data": [ /* VodRecord[] */
    {
      "id": 12,
      "appId": 1,
      "streamId": "cam-42",
      "room": "live-demo",
      "name": "live-demo-2026-06-30",
      "fileKey": "streamhub/live/live-demo-2026-06-30.mp4",
      "s3Url": "https://s3.us-east-1.wasabisys.com/ale-backup/streamhub/live/live-demo-2026-06-30.mp4",
      "publicUrl": null,
      "sizeBytes": 10485760,
      "durationS": 120,
      "width": 1280,
      "height": 720,
      "format": "mp4",
      "status": "ready",
      "localPath": null,
      "startedAt": "2026-06-30T12:00:00.000Z",
      "endedAt": "2026-06-30T12:02:00.000Z",
      "metatagsJson": "{\"room\":\"live-demo\",\"codec\":\"h264\"}",
      "snapshotKey": "streamhub/live/snapshots/live-demo-2026-06-30.jpg"
    }
  ],
  "total": 137,
  "limit": 50,
  "offset": 0,
  "error": null
}
```

`status` is one of `recording | uploading | ready | failed`.

```bash
# newest 50 ready VODs of a room, by size
curl -s "https://streamhub.example.com/api/v1/apps/live/vods?status=ready&room=live-demo&order=size_bytes&dir=desc&limit=50" \
  -H "Authorization: Bearer $STREAMHUB_TOKEN"
```

### GET /apps/{app}/vods/{id}

VOD detail with a **freshly generated presigned playback URL** plus the
**post-transcode variants** (adaptive HLS ladder / alternate encodings) when the app
has `transcoding` enabled (see
[config-reference.md](./config-reference.md#transcoding) and
[features/adaptive-vod.md](./features/adaptive-vod.md)).

**Response 200**: a `VodRecord` plus `url` / `presignedUrl` / `publicUrl`,
`adaptive` and `variants`:

```json
{
  "data": {
    "id": 12,
    "status": "ready",
    "url": "https://cdn.example.com/rec-123.mp4",
    "presignedUrl": "https://s3.us-east-1.wasabisys.com/ale-backup/streamhub/live/...&X-Amz-Signature=...",
    "publicUrl": "https://cdn.example.com/rec-123.mp4",
    "adaptive": {
      "masterKey": "hls/rec-123/master.m3u8",
      "masterUrl": "https://cdn.example.com/hls/rec-123/master.m3u8"
    },
    "variants": [
      { "id": 1, "kind": "master",    "format": "hls",      "height": null, "bitrateKbps": null, "key": "hls/rec-123/master.m3u8",      "sizeBytes": 312,   "url": "https://cdn.example.com/hls/rec-123/master.m3u8" },
      { "id": 2, "kind": "rendition", "format": "hls-h264", "height": 720,  "bitrateKbps": 2800, "key": "hls/rec-123/720p/index.m3u8",  "sizeBytes": 91834, "url": "https://cdn.example.com/hls/rec-123/720p/index.m3u8" },
      { "id": 3, "kind": "rendition", "format": "hls-h264", "height": 480,  "bitrateKbps": 1400, "key": "hls/rec-123/480p/index.m3u8",  "sizeBytes": 51210, "url": "https://cdn.example.com/hls/rec-123/480p/index.m3u8" },
      { "id": 4, "kind": "alternate", "format": "webm-vp8", "height": 1080, "bitrateKbps": 2800, "key": "rec-123.webm",                 "sizeBytes": 88112, "url": "https://cdn.example.com/rec-123.webm" }
    ],
    "...": "...other VodRecord fields..."
  },
  "error": null
}
```

- `adaptive` is the entry point for adaptive playback: point an HLS player at
  `adaptive.masterUrl` (or `null` when no ladder was generated — e.g. transcoding off).
- `variants` is empty for a plain (non-transcoded) VOD; the base MP4 is always the
  `VodRecord` itself (`url`/`presignedUrl`/`publicUrl`).
- `presignedUrl` may be `null` if the object key is not set or presigning is
  unavailable.
- **HLS URLs require `s3.public_url`** (public/CDN base): segments are fetched
  relative to the playlist, so a presigned playlist alone can't play. Without a public
  base, rendition `url`s are `null` (the master/alternates fall back to presigned).

```bash
curl -s https://streamhub.example.com/api/v1/apps/live/vods/12 \
  -H "Authorization: Bearer $STREAMHUB_TOKEN"
```

### GET /apps/{app}/vods/{id}/download

Get a **download** URL for a VOD (forces an attachment, not inline playback).
Requires `vod:read`.

- **S3-backed VOD** → a presigned GET URL with a `response-content-disposition`
  of `attachment; filename="<name|room>-<id>.<ext>"` (short-lived, 1h).
- **Local-only VOD** (no S3 object yet, file still on disk) → `url` points at the
  [`/raw`](#get-appsappvodsidraw) streaming endpoint and `expiresInSeconds` is `null`.
- `409 Conflict` when the VOD is not `ready`.
- `404` when it is ready but has neither an S3 object nor a local file.

**Response 200**

```json
{
  "data": {
    "url": "https://s3.us-east-1.wasabisys.com/ale-backup/streamhub/live/clip.mp4?...&response-content-disposition=attachment%3B%20filename%3D%22clip-12.mp4%22&X-Amz-Signature=...",
    "filename": "clip-12.mp4",
    "expiresInSeconds": 3600
  },
  "error": null
}
```

```bash
curl -s https://streamhub.example.com/api/v1/apps/live/vods/12/download \
  -H "Authorization: Bearer $STREAMHUB_TOKEN"
```

### GET /apps/{app}/vods/{id}/raw

Stream a **local** VOD file directly, as an attachment download
(`Content-Disposition: attachment`). Requires `vod:read`. This is what a local-only
`/download` points at. `409` when not ready, `404` when there is no local file.

```bash
curl -L -o clip.mp4 \
  https://streamhub.example.com/api/v1/apps/live/vods/12/raw \
  -H "Authorization: Bearer $STREAMHUB_TOKEN"
```

### DELETE /apps/{app}/vods/{id}

Delete a VOD: the DB row **and** the S3 object, its snapshot, and any local file.

**Response 200**

```json
{ "data": { "id": 12, "deleted": true }, "error": null }
```

```bash
curl -s -X DELETE https://streamhub.example.com/api/v1/apps/live/vods/12 \
  -H "Authorization: Bearer $STREAMHUB_TOKEN"
```

---

## Stats

### GET /apps/{app}/stats

Per-app operational snapshot for the dashboard. Requires `app:read`. The result is
**cached 5s in memory** per app so a polling dashboard never hammers LiveKit.

Blocks:

- **`live`** — active stream count plus per-room `publishers` and `viewers`.
  `viewers`/`totalViewers` are `null` when the app's `viewerCounter` feature is off
  (or LiveKit is unreachable) — the endpoint never fails just because a live count
  is unavailable. Reuses the streams-service `listParticipants` logic.
- **`vods`** — `count`, `totalBytes`, and a `byStatus` rollup (all four keys always
  present).
- **`storage`** — `appDbBytes` (the app's `app.db` footprint) and `vodBytes`.
- **`ingress`** — `total` / `active` counts derived from the app's ingress-typed
  (`rtmp`/`whip`/`rtsp`) stream rows.
- **`events24h`** — `error`/`warn`/`info` counts from `server_logs` over the last 24h,
  attributed by app.

**Response 200**

```json
{
  "data": {
    "ts": "2026-07-02T10:00:00.000Z",
    "app": { "name": "live", "displayName": "Live" },
    "live": {
      "activeStreams": 1,
      "totalViewers": 2,
      "rooms": [
        { "room": "live-room-1", "viewers": 2, "publishers": 1, "startedAt": "2026-07-02 09:59:31" }
      ]
    },
    "vods": {
      "count": 3,
      "totalBytes": 3000,
      "byStatus": { "ready": 2, "failed": 1, "recording": 0, "uploading": 0 }
    },
    "storage": { "appDbBytes": 45056, "vodBytes": 3000 },
    "ingress": { "total": 1, "active": 1 },
    "events24h": { "error": 1, "warn": 1, "info": 2 }
  },
  "error": null
}
```

```bash
curl -s https://streamhub.example.com/api/v1/apps/live/stats \
  -H "Authorization: Bearer $STREAMHUB_TOKEN"
```

---

## Streams

A **stream** is an active publisher in a room (webrtc participant, or an rtmp/rtsp/whip
ingress). Rows are upserted by the LiveKit webhook handlers and reconciled against live
LiveKit rooms.

### GET /apps/{app}/streams

List active streams for the app.

**Response 200** — array of `StreamResponseDto`:

```json
[
  {
    "id": 1,
    "appId": 1,
    "streamId": "live-demo/camera-1",
    "type": "webrtc",
    "room": "live-demo",
    "participant": "camera-1",
    "status": "active",
    "startedAt": "2026-06-30T12:00:00.000Z",
    "endedAt": null,
    "lastStatsJson": "{\"live\":true,\"participants\":2,\"publishers\":1}"
  }
]
```

`type` ∈ `webrtc | rtmp | rtsp | whip`; `status` ∈ `active | ended`.

```bash
curl -s https://streamhub.example.com/api/v1/apps/live/streams \
  -H "Authorization: Bearer $STREAMHUB_TOKEN"
```

### GET /apps/{app}/streams/{id}

Stream detail. For active streams it does a **best-effort live enrichment**, querying
LiveKit for the participant list and writing `lastStatsJson` with
`{ live, participants, publishers }`. The **viewer counter** (SPEC §16) is derived from
this: viewers = subscribers (participants that are not publishers, excluding hidden/QC).

**Response 200**: `StreamResponseDto` (as above). **404** if not found.

```bash
curl -s https://streamhub.example.com/api/v1/apps/live/streams/live-demo/camera-1 \
  -H "Authorization: Bearer $STREAMHUB_TOKEN"
```

### DELETE /apps/{app}/streams/{id}

Stop a stream: disconnects the participant (webrtc) / removes the ingress (rtmp/whip/rtsp)
/ ends the room when no other active streams remain, and marks the row `ended`. LiveKit
cleanup is best-effort; the row is always marked ended.

**Response 204 No Content.** **404** if not found.

```bash
curl -s -X DELETE https://streamhub.example.com/api/v1/apps/live/streams/live-demo/camera-1 \
  -H "Authorization: Bearer $STREAMHUB_TOKEN"
```

---

## Snapshots

### POST /apps/{app}/snapshots

Capture a single frame from a room via ffmpeg and (if S3 is configured) upload it to the
app bucket.

**Body** (`SnapshotDto`)

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `room` | string | yes | LiveKit room name (1..256) |
| `participantIdentity` | string | no | snapshot a specific participant; default = room composite / last frame |

**Response 200** (`SnapshotResultDto`)

```json
{
  "key": "streamhub/live/snapshots/lobby-2026-06-30.jpg",
  "url": "https://s3.us-east-1.wasabisys.com/ale-backup/...signed"
}
```

```bash
curl -s -X POST https://streamhub.example.com/api/v1/apps/live/snapshots \
  -H "Authorization: Bearer $STREAMHUB_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"room":"live-demo","participantIdentity":"camera-1"}'
```

---

## Config & Transcoding

These endpoints expose the **adaptive / transcoding** portion of the app config (no
secrets). The broader app config (display name, recording toggle, callbacks) is patched
through the global `PATCH /apps/{name}` (see [api-global.md](./api-global.md)). Full
config reference: [config-reference.md](./config-reference.md).

### GET /apps/{app}/config

Get the adaptive/transcoding config for the app (secrets stripped).

**Response 200** (`TranscodingConfigView`)

```json
{
  "adaptive": true,
  "layers": [
    { "name": "high", "height": 720 },
    { "name": "med", "height": 480 },
    { "name": "low", "height": 240 }
  ],
  "rtmp": { "enabled": true, "transcode": true },
  "transcoding": {
    "enabled": false,
    "encoding": "h264",
    "vodAdaptive": false,
    "vodRenditions": [],
    "hwaccel": "auto",
    "hwaccelResolved": { "requested": "auto", "effective": "cpu", "type": "none", "reason": "..." }
  }
}
```

`transcoding.enabled` is the server-side master switch — **false on new apps**
(passthrough). See [config-reference.md](./config-reference.md#transcoding).

```bash
curl -s https://streamhub.example.com/api/v1/apps/live/config \
  -H "Authorization: Bearer $STREAMHUB_TOKEN"
```

### PATCH /apps/{app}/config

Patch the adaptive/transcoding config. All fields optional; PATCH only what changed. A
provided `layers` array **replaces** the full ladder.

**Body** (`UpdateTranscodingConfigDto`)

| Field | Type | Notes |
|-------|------|-------|
| `adaptive` | boolean | enable simulcast WebRTC delivery |
| `layers` | `{name,height}[]` | 1..8 entries; `name` short slug, `height` 1..4320 |
| `rtmpTranscode` | boolean | transcode RTMP ingress to a multi-layer ladder (needs `transcodingEnabled`) |
| `transcodingEnabled` | boolean | server-side transcoding **master switch** (default `false` = passthrough) |
| `encoding` | `h264` \| `h264+vp8` | recording output target; `h264+vp8` adds a WebM/VP8 alternate per VOD (ffmpeg post-transcode) |
| `vodAdaptive` | boolean | generate an adaptive HLS VOD (master + renditions) per recording |
| `vodRenditions` | `{height,bitrateKbps}[]` | ≤ 8 entries; replaces the whole VOD ladder; empty = derive from `layers` |
| `hwaccel` | `auto` \| `gpu` \| `cpu` | GPU hardware-transcoding preference |

```json
{
  "transcodingEnabled": true,
  "encoding": "h264+vp8",
  "vodAdaptive": true,
  "vodRenditions": [ {"height":720,"bitrateKbps":2800}, {"height":480,"bitrateKbps":1400} ]
}
```

**Response 200**: the merged `TranscodingConfigView`.

```bash
curl -s -X PATCH https://streamhub.example.com/api/v1/apps/live/config \
  -H "Authorization: Bearer $STREAMHUB_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"adaptive":true,"layers":[{"name":"high","height":720},{"name":"low","height":360}]}'
```

### GET /apps/{app}/transcoding/layers

Effective WebRTC rendition ladder for the app (defaults to 720/480/240 when not
configured).

**Response 200**

```json
[
  { "name": "high", "height": 720 },
  { "name": "med", "height": 480 },
  { "name": "low", "height": 240 }
]
```

```bash
curl -s https://streamhub.example.com/api/v1/apps/live/transcoding/layers \
  -H "Authorization: Bearer $STREAMHUB_TOKEN"
```

---

## Logs

### GET /apps/{app}/logs

Logs attributed to this app (`server_logs.app_id`). Same envelope and filters as
the global [`GET /logs`](./api-global.md#get-logs), but the app comes from the
path and every row is scoped to it — a caller only ever sees its own app's logs.
Newest first, paginated.

**Auth**: Bearer. Permission: `usage:read` (+ the app must belong to the caller's
tenant, same data-scope as the other per-app routes).

**Query**

| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `level` | enum | — | `trace`\|`debug`\|`info`\|`warn`\|`error`\|`fatal` |
| `source` | string | — | Exact match on the emitting subsystem (≤ 64) |
| `q` | string | — | Free-text search over the message (`LIKE %…%`, escaped; ≤ 200) |
| `since` | ISO-8601 | — | Lower bound (inclusive) |
| `until` | ISO-8601 | — | Upper bound (inclusive) |
| `limit` | int | 100 | 1..1000 |
| `offset` | int | 0 | ≥ 0 |

**Response 200** (paginated envelope, identical shape to the global viewer)

```json
{
  "data": [
    {
      "id": 42,
      "ts": "2026-06-30T12:00:00.000Z",
      "level": "info",
      "source": "recording",
      "appId": 1,
      "message": "recording started",
      "metaJson": "{\"room\":\"live-demo\"}"
    }
  ],
  "total": 1,
  "limit": 100,
  "offset": 0
}
```

```bash
curl -s "https://streamhub.example.com/api/v1/apps/live/logs?level=error&q=egress&limit=50" \
  -H "Authorization: Bearer $STREAMHUB_TOKEN"
```

---

## Data / Chat / Reactions

Chat, emojis and animated reactions (SPEC §16) ride on **LiveKit data channels**, not on
the StreamHub REST API. They are enabled per app via `features.chat` / `features.reactions`
(see [config-reference.md](./config-reference.md#features-spec-16)).

- **Transport**: LiveKit `DataPacket`s over reserved topics:
  - `chat` — chat messages and emojis;
  - `reaction` — animated reactions (floating hearts/likes).
- **Grant**: join tokens are minted with `canPublishData: true`, so any client with a
  token from `POST /apps/{app}/tokens` can publish/subscribe to these topics directly
  through the LiveKit JS client.
- **Server side**: when these events occur, the app's outbound **callbacks** fire
  (`chat_message`, `reaction`). Those payloads are documented in
  [webhooks.md](./webhooks.md#outbound-callbacks).
- **Player**: the embedded player / sample pages render a chat widget and a reactions bar
  when the feature flags are on.

> There is no dedicated REST endpoint to post a chat message or reaction — by design the
> media plane (LiveKit data channels) carries them, and StreamHub observes/forwards via
> callbacks.
