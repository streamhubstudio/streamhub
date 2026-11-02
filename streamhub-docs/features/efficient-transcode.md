# Ingest profiles: `livekit` (stable default) vs `efficient` (opt-in)

## TL;DR

`STREAMHUB_INGEST_PROFILE` is the **global switch** for how the LiveKit-transcoded
RTMP/URL ingress is encoded:

| Profile | Who decides the encoding | Behaviour | Status |
|---|---|---|---|
| **`livekit`** (default) | **LiveKit** — StreamHub attaches *no* encoding opinions | The long-standing legacy routing (LiveKit's default = a 3-layer 720p H.264 simulcast, ~3 software encodes/stream) | **Stable** — new installs always start here |
| **`efficient`** | **StreamHub** — attaches an explicit LiveKit **preset** | Single-layer preset by default (measured: 3×1080p ≈ 100% → **~24%** of an 8-core box); capped 3-layer preset only when the app opts into adaptive | **Experimental, opt-in** |

- Server-wide; **on a cluster set it in each node's `.env`**. Read at boot →
  **restart the core to apply** (`systemctl restart` / `docker compose up -d core`).
- Applies to **newly-created ingresses** (LiveKit ingress config is immutable —
  delete + recreate an existing one to re-encode it).
- **Instant rollback:** set `STREAMHUB_INGEST_PROFILE=livekit` (or remove the
  var) + restart. StreamHub then sends exactly what pre-2.7.1 versions sent.

```bash
# .env — opt in to the efficient profile
STREAMHUB_INGEST_PROFILE=efficient
# rollback to the stable legacy routing
STREAMHUB_INGEST_PROFILE=livekit   # (or just remove the line)
```

## Why the `efficient` profile exists

LiveKit's default for a transcoded RTMP/URL input is a **3-layer 720p simulcast**
— three real-time x264 encodes per stream. Measured on prod (8-core box,
software x264): **3 concurrent 1080p sources pinned the machine at ~100%**.
The same load with the single-layer profile: **~24%**.

### Measured CPU — 3× 1080p sources, 8-core box (prod, 2026-07-09)

| Ingress encoding | Encodes / stream | 3-stream total |
|---|---|---|
| LiveKit default (3-layer 720p simulcast) | 3 | **~100%** |
| `efficient` single-layer (720p preset) | 1 | **~24%** |
| audio-only ingest | 0 video | (see footgun note below) |
| RTMP→HLS passthrough (remux) | 0 | ~1% |

**Honest nuance:** with a high-res (1080p) source the H.264 **decode** is the
dominant fixed cost (~0.5 core/stream), so the OUTPUT resolution cap barely moves
single-layer CPU — **the layer count (1 vs 3) is the CPU lever**, the cap is a
quality/bandwidth knob. For near-idle CPU use
[passthrough](./rtmp-passthrough.md) (no transcode at all).

## Stability rules (learned the hard way, locked by tests)

1. **Presets only.** The `efficient` profile only ever sends LiveKit's built-in
   `IngressVideoEncodingPreset` values — never hand-rolled
   `IngressVideoEncodingOptions` layers. Custom options proved
   **LiveKit-version-coupled**: server 1.8.4 rejects `videoCodec: H264_MAIN`
   with `invalid video parameters: video codec unsupported` (a bug that shipped
   in 2.8.1 because unit tests mock the ingress client — only a functional test
   against the live server caught it). Presets are validated by LiveKit itself.
2. **Fallback-on-reject.** If LiveKit rejects StreamHub's encoding options for
   any reason, `createIngress` logs a warning and **retries once with no
   opinions** (LiveKit's own defaults). An encoding option can only ever
   *degrade* the profile — it can never break ingress creation. (In `livekit`
   profile there is nothing to reject, so errors propagate as before.)
3. **The audio-only footgun is closed.** LiveKit servers up to at least 1.8.4
   **ignore** the `audioOnly` ingress flag; an ingress with *no* video options
   then falls back to the 3-layer default — the worst possible outcome for a
   flag meant to *save* CPU. In `efficient` mode an `audioOnly` request now
   still attaches the single-layer preset (worst case: one layer, never three).
   For a real radio use **[RTMP→HLS passthrough](./rtmp-passthrough.md)**.
4. **The `livekit` profile is *exact* legacy.** It forwards no `video`, no
   `audioOnly` — only the WHIP-bypass guard (a correctness fix) and the
   long-standing GPU hw-accel path remain. What LiveKit did before, it does now.

## What `efficient` sends per app config

Chosen from `webrtc.transcode_max_height` (`360|480|720|1080`, default `720`,
per-app) and `webrtc.adaptive`:

| App config | Preset sent |
|---|---|
| adaptive off (default), cap ≤ 720 | `H264_720P_30FPS_1_LAYER` — sub-720 caps **fold up** to 720 (presets-only rule; the cap barely moved CPU anyway, see nuance above) |
| adaptive off, cap 1080 | `H264_1080P_30FPS_1_LAYER` |
| adaptive **on**, cap ≤ 720 | `H264_720P_30FPS_3_LAYERS` (the ladder, but chosen explicitly + capped) |
| adaptive **on**, cap 1080 | `H264_1080P_30FPS_3_LAYERS` |
| GPU node (opt-in sidecar), adaptive on | GPU simulcast preset (unchanged) |

Set the cap via `PATCH /apps/:app` → `{ "transcodeMaxHeight": 1080 }` (the DTO
rejects out-of-set values; hand-edited yaml snaps to the nearest tier).

## Interactions

- **WHIP passthrough (`enableTranscoding:false`)**: no transcode → no options
  attached, both profiles. Unchanged.
- **RTMP→HLS passthrough (remux)**: bypasses LiveKit entirely — governed by its
  own switch (`STREAMHUB_RTMP_PASSTHROUGH_ENABLE`), unaffected by the ingest
  profile.
- **Existing ingresses**: unaffected until deleted + recreated.

## Cluster

Both the env switch and the per-app cap are consumed **at ingress-create time on
whichever node owns the room** — no shared/central state. Set
`STREAMHUB_INGEST_PROFILE` in each node's `.env` (keep them consistent) and
restart that node's core. Per-app config replicates with the app itself.

## Rollback runbook

1. `.env` → `STREAMHUB_INGEST_PROFILE=livekit` (or delete the line — it's the default).
2. Restart the core: `systemctl restart skyline-core` (bare-metal) /
   `docker compose up -d core` (compose nodes — note `restart` does NOT re-read
   `.env`).
3. Recreate any ingress you want back on LiveKit's default encoding.
4. Done — StreamHub is byte-for-byte back to the legacy ingest routing.

## Where it lives

- Switch: `streamhub-core-go/internal/platform/config/config.go` → `IngestProfile`
  (`STREAMHUB_INGEST_PROFILE`, default `livekit`).
- Profile gate + fallback-on-reject: `Service.CreateIngress`
  (`internal/livekit/service.go`), tests in `internal/livekit` (profiles, presets,
  fallback, footgun).
- Preset builder: `BuildIngressVideoOptions` in `internal/livekit/util.go`
  (presets-only invariant locked by its tests).
- Per-app cap: `AppsService` (`webrtc.transcode_max_height`),
  `UpdateAppConfigDto.transcodeMaxHeight`.
