# Transcoding & GPU

## What it does

Per-app adaptive video (simulcast ladder) plus GPU hardware-transcoding
awareness. Live delivery uses LiveKit's native **simulcast** + ingress
`enableTranscoding` (multi-layer); the app defines the rendition ladder
(default 720/480/240). Each node detects its GPU and apps pick a `hwaccel`
preference.

## GPU detection (system module)

Detects **NVIDIA** (`nvidia-smi`) and **VAAPI** (`/dev/dri`). Never throws — a
node with no GPU/driver/permission reports `available:false, type:"none"`.

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/system/gpu?refresh=<bool>` | Bearer | GPU status (cached; `refresh=true` re-probes) |
| POST | `/system/gpu/refresh` | Bearer | Force a fresh probe |

### GpuStatus

```json
{
  "available": true,
  "type": "nvidia",                 // nvidia | vaapi | none
  "devices": [ { "kind": "nvidia", "name": "NVIDIA GeForce RTX 3090", "index": 0, "memoryMiB": 24576 } ],
  "driver": "550.xx",
  "checkedAt": "2026-06-30T12:00:00.000Z",
  "detail": "nvidia-smi ok"
}
```

Exported to Prometheus as `streamhub_gpu_available{type}`.

## Per-app transcoding config

| Method | Path | Permission | Purpose |
|--------|------|-----------|---------|
| GET | `/apps/:app/config` | config:read | Adaptive/transcoding config view (no secrets) |
| PATCH | `/apps/:app/config` | config:write | Patch adaptive/layers/rtmpTranscode/hwaccel/features |
| GET | `/apps/:app/transcoding/layers` | config:read | Effective WebRTC rendition ladder |

> Note: `PATCH /apps/:app/config` is served by the transcoding module (adaptive,
> layers, rtmpTranscode, hwaccel, features). The **flat** app patch
> (`PATCH /apps/:name`) in apps-multitenant.md targets display/recording/callbacks.

### GET /apps/:app/config — TranscodingConfigView

```json
{
  "app": "demo",
  "adaptive": true,
  "layers": [ {"name":"high","height":720}, {"name":"med","height":480}, {"name":"low","height":240} ],
  "rtmp": { "enabled": true, "transcode": true },
  "features": { "rtmpPassword": false, "viewerCounter": true, "chat": true,
                "reactions": true, "hiddenQc": false, "adaptivePlayer": true },
  "transcoding": {
    "hwaccel": "auto",
    "hwaccelResolved": {
      "requested": "auto", "effective": "gpu", "type": "nvidia",
      "reason": "auto → GPU available (nvidia)"
    }
  }
}
```

### PATCH /apps/:app/config — body (all optional)

```json
{
  "adaptive": true,
  "layers": [ {"name":"high","height":720}, {"name":"low","height":360} ],
  "rtmpTranscode": true,
  "hwaccel": "auto",
  "features": { "adaptivePlayer": true }
}
```

- `layers`: 1..8 items; each `{ name (slug), height (1..4320) }`. Replaces the ladder.
- `hwaccel` ∈ `auto` | `gpu` | `cpu`:
  - `auto` (default) — GPU when the node has one, else CPU.
  - `gpu` — force GPU (falls back to CPU if none).
  - `cpu` — always software.

## Examples

```bash
curl -s $BASE/system/gpu -H "Authorization: Bearer $TOKEN"
curl -s $BASE/apps/demo/config -H "Authorization: Bearer $TOKEN"
curl -s $BASE/apps/demo/transcoding/layers -H "Authorization: Bearer $TOKEN"

# force GPU + a 2-layer ladder
curl -s -X PATCH $BASE/apps/demo/config -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"hwaccel":"gpu","layers":[{"name":"high","height":720},{"name":"low","height":360}]}'
```

## Notes

- When `adaptivePlayer` is on, minted tokens carry the simulcast ladder in
  metadata (`streamhub.simulcast`) and ingress transcoding is enabled.
- The GPU/hwaccel resolution feeds the media pipeline (egress/ingress workers
  co-located with the core); metered as `streamhub_media_transcode_total{kind,accel,type}`.
- Media pipeline deployment (GPU passthrough for the egress/ingress containers)
  is covered by the repo's deploy docs (`deploy/DEPLOY.md`).
</content>
