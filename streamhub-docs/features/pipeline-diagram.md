# App media-pipeline diagram

## What it does

Every app has a **resolved media-pipeline topology** — how media enters
(ingest), what happens to it (processing), how it leaves (delivery), where it is
stored, and which plugins are attached. `GET /apps/:app/pipeline` returns that
topology as JSON, and the dashboard **Overview** renders it as an animated SVG
flow (`AppFlowDiagram`) that shows only the stages this app actually has enabled,
with a live pulse on the lanes that are currently active.

The endpoint is a **read-only, credential-free** view of `config.yaml` plus a few
cheap live hints — it never mutates anything and never returns S3 keys or
endpoints (only the bucket name).

## Endpoint

| Method | Path | Permission | Purpose |
|--------|------|-----------|---------|
| GET | `/apps/:app/pipeline` | app:read | Resolved pipeline topology for the flow diagram |

- Envelope: `{ "data": <AppPipeline>, "error": null }`.
- `404` on an unknown app.
- Same Bearer auth as every other `/apps/:app/*` GET.

## How the topology is resolved

`config.yaml` is the **source of truth** for what is *enabled*; live hints only
drive the *active* flags. Resolution order:

1. **`config.yaml`** (via `AppsService.getConfig`) — the `rtmp` / `webrtc` /
   `transcoding` / `recording` / `s3` / `features` blocks decide which nodes are
   enabled. Unknown app ⇒ 404.
2. **GPU detection** (`HwAccelService`) — the transcoding node's *effective*
   encoder (`gpu`/`cpu`) after per-node GPU detection, with a CPU fallback that
   never fails when there is no GPU.
3. **Per-app `streams` table** — active streams (`status='active'`) drive every
   `active` flag. Wrapped so a DB hiccup degrades to "inactive", never a 500.
4. **On-disk HLS playlists** — the existence of
   `apps/<app>/hls/<room>/index.m3u8` for an active room drives the HLS delivery
   `active` flag.

No LiveKit round-trips are made (per-room dials are not cheap), so the call is
fast enough to poll.

## Response shape (`AppPipeline`)

```jsonc
{
  "ingest": [                       // fixed order; only enabled ones are shown in the diagram
    { "type": "rtmp",  "enabled": true,  "active": true,  "label": "RTMP", "detail": "…" },
    { "type": "rtmps", "enabled": true,  "active": true,  "label": "RTMPS" },
    { "type": "whip",  "enabled": false, "active": false, "label": "WHIP" },
    { "type": "webrtc","enabled": true,  "active": false, "label": "WebRTC" },
    { "type": "rtsp",  "enabled": true,  "active": false, "label": "RTSP / URL pull" },
    { "type": "ws-mjpeg","enabled": false,"active": false,"label": "WS-MJPEG" }
  ],
  "processing": {
    "transcoding": { "enabled": true, "encoder": "gpu", "hwaccel": "auto" },
    "adaptive":    { "enabled": true, "layers": [ { "name": "720p", "height": 720 }, … ] }
  },
  "delivery": [
    { "type": "webrtc", "enabled": true, "active": true,  "label": "WebRTC" },
    { "type": "hls",    "enabled": true, "active": true,  "label": "HLS" },
    { "type": "cdn",    "enabled": false,"active": false, "label": "CDN" }
  ],
  "storage": {
    "recording": { "enabled": true, "splitMinutes": 30, "snapshotSeconds": 10 },
    "s3":        { "configured": true, "bucket": "my-app-bucket" }   // bucket NAME only — never keys/endpoint
  },
  "plugins": [ { "id": "yolo", "enabled": true }, { "id": "watermark", "enabled": false } ],
  "live":    { "activeStreams": 2 }
}
```

Field notes:

- **`ingest`** — fixed-order array. The wire type union also lists `url`, but the
  shipped topology folds URL-pull into the **`rtsp`** node. `rtmps` is enabled
  only when `rtmp.enabled && STREAMHUB_RTMPS_ENABLE`, and its `active` mirrors the
  `rtmp` live hint (RTMPS terminates into the same RTMP ingress).
- **`processing.transcoding.encoder`** is the *effective* value after live GPU
  detection; **`hwaccel`** is the configured preference (`auto`/`gpu`/`cpu`).
- **`delivery.cdn`** is enabled when either `s3.publicUrl` is set **or**
  `STREAMHUB_HLS_CDN` is truthy; it is `active` only when `STREAMHUB_HLS_CDN` is
  on *and* HLS is live.
- **`storage.s3.configured`** = both an access key and a secret exist; only the
  **bucket name** is ever exposed — no keys, no endpoint.
- **`storage.recording`** carries `splitMinutes` / `snapshotSeconds` only when
  those are set (> 0).
- **`live.viewers`** is intentionally omitted (it would require per-room LiveKit
  dials); only `activeStreams` is returned.

## The dashboard flow diagram (`AppFlowDiagram`)

The Overview's **Pipeline** card polls this endpoint (same 10s cadence as the
stats card) and renders a single inline **animated SVG**:

```
enabled ingest sources ─▶ StreamHub core ─▶ processing (transcode / adaptive) ─▶ delivery endpoints
                                     └────────────────▶ storage lane (recording → S3)
                          AI-plugin chips sit above the core
```

- Only **enabled** stages are drawn; the rest are hidden, so the diagram is a
  faithful picture of *this* app's configuration.
- **Active vs configured** — lanes carrying live media animate faster/brighter
  (marching-dash cables + SMIL `animateMotion` signal packets + node arrival
  flashes); dormant-but-configured lanes render as a static faint dashed line.
- **Accessible & theme-aware** — honours `prefers-reduced-motion` (settles to a
  static, fully-labelled diagram) and follows the dashboard light/dark theme via
  `--sh-*` tokens. Strings are i18n'd (`en`/`es`).

The geometry and pulse schedule are pure/deterministic (`lib/pipelineFlow.ts`,
unit-tested), so the diagram is reproducible and cheap to render.

## Example

```bash
curl -s "$BASE/apps/demo/pipeline" -H "Authorization: Bearer $TOKEN" | jq '.data | keys'
# [ "delivery", "ingest", "live", "plugins", "processing", "storage" ]
```
