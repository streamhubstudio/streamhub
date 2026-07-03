# GPU hardware transcoding (optional)

StreamHub can hardware-accelerate LiveKit **egress** (recording / HLS / RTMP
broadcast) and **ingress** (RTMP/URL → room) encoding when the node that runs
those workers has a GPU. The feature is fully **optional and auto-detecting**:
on a node with no GPU it reports `none` and everything runs on CPU exactly as
before. Nothing about this feature can break ingress/egress — every failure path
falls back to CPU.

---

## TL;DR

- `GET /api/v1/system/gpu` → `{ available, type, devices, driver? }`.
- Per-app preference: `PATCH /api/v1/apps/:app/config { "hwaccel": "auto|gpu|cpu" }`
  (default `auto`). Global default: env `TRANSCODING_HWACCEL`.
- `auto` = use the GPU if the node has one, else CPU. `gpu` = force GPU, fall
  back to CPU if none. `cpu` = always software.
- **Detection alone does not make encoding faster.** It only decides *gpu vs cpu*
  and tags the egress/ingress request with explicit H.264 encoding options. The
  *actual* hardware encoder (NVENC / VAAPI) is provided by the **egress/ingress
  worker image + node runtime** — see [What a GPU node actually
  needs](#what-a-gpu-node-actually-needs-to-accelerate-for-real).

---

## Endpoints & config

### `GET /api/v1/system/gpu`  (auth: Bearer)

Probes the node and returns its capability. Robust: a missing binary, denied
permission, or odd output degrades to `available:false, type:'none'` — it never
errors. Pass `?refresh=true` (or `POST /api/v1/system/gpu/refresh`) to force a
fresh probe (the result is otherwise cached after boot).

```jsonc
// NVIDIA node
{
  "available": true,
  "type": "nvidia",
  "devices": [{ "kind": "nvidia", "name": "NVIDIA GeForce RTX 3090", "index": 0, "memoryMiB": 24576 }],
  "driver": "550.90.07",
  "checkedAt": "2026-07-01T00:00:00.000Z",
  "detail": "nvidia-smi reported 1 GPU(s)"
}

// CPU-only node
{ "available": false, "type": "none", "devices": [], "checkedAt": "…",
  "detail": "no NVIDIA (nvidia-smi) and no VAAPI (/dev/dri render node)" }
```

Detection order: **NVIDIA** (`nvidia-smi --query-gpu=…`) is tried first, then
**VAAPI** (`/dev/dri/renderD*` render nodes; `vainfo` is consulted only to label
the driver and is not required).

### Per-app `hwaccel`

The preference is part of the transcoding config:

```bash
# read (includes resolved decision for THIS node)
GET  /api/v1/apps/live/config
#   → { …, "transcoding": { "hwaccel": "auto",
#         "hwaccelResolved": { "requested":"auto", "effective":"gpu",
#                              "type":"nvidia", "reason":"…" } } }

# set
PATCH /api/v1/apps/live/config   { "hwaccel": "gpu" }
```

Storage: the per-app preference lives in a small sidecar
`DATA_DIR/apps/<app>/transcoding.json` owned by the transcoding module (the
app's `config.yaml` and DB are untouched). The global default comes from
`TRANSCODING_HWACCEL` (`auto` | `gpu` | `cpu`, default `auto`).

### Resolution / fallback

For each ingress/egress the core resolves the effective path:

| app `hwaccel` | GPU available | effective |
|---------------|---------------|-----------|
| `cpu`         | any           | **cpu**   |
| `gpu`         | yes           | **gpu**   |
| `gpu`         | no            | **cpu** (logged fallback) |
| `auto`        | yes           | **gpu**   |
| `auto`        | no            | **cpu**   |

When `gpu` is chosen the core attaches explicit H.264 encoding options to the
LiveKit request (egress `EncodingOptions` H264_MAIN 1280x720@30; ingress
`IngressVideoOptions` preset `H264_720P_30FPS_3_LAYERS`). When `cpu` is chosen it
attaches nothing — identical to the pre-GPU behaviour. Any error while resolving
or building options is caught and downgraded to CPU, so **ingress/egress is never
broken by this feature**.

---

## What a GPU node actually needs to accelerate *for real*

The `livekit-server-sdk` request can only carry the **target codec / resolution /
bitrate** — it *cannot* select the ffmpeg encoder (`libx264` vs `h264_nvenc` vs
VAAPI). That choice is made by the **egress / ingress worker** based on how it was
built and what the node exposes. So `GET /system/gpu` reporting `nvidia` is
necessary but **not sufficient**; to get true hardware encoding the node running
the LiveKit **egress** (and, for transcoded ingress, the **ingress**) worker also
needs:

### NVIDIA (NVENC)

1. **NVIDIA driver** on the host (the same one `nvidia-smi` reports).
2. **nvidia-container-toolkit** so containers can see the GPU
   (`--gpus all` / `runtime: nvidia` / device `nvidia.com/gpu`).
3. An **egress/ingress image built with NVENC** support (LiveKit publishes
   GPU-enabled egress images; a stock CPU egress image will *not* use NVENC even
   on a GPU host). Point the worker's config at the GPU pipeline.
4. Run the worker with the GPU exposed, e.g.:

   ```yaml
   # docker-compose (egress)
   services:
     egress:
       image: livekit/egress:<gpu-tag>
       runtime: nvidia            # or: deploy.resources.reservations.devices
       environment:
         - NVIDIA_VISIBLE_DEVICES=all
         - NVIDIA_DRIVER_CAPABILITIES=all
       # egress.yaml should enable the hardware (NVENC) encoding pipeline
   ```

   Verify with `nvidia-smi` inside the container and watch the **Encoder**
   utilisation (`nvidia-smi dmon` / `-q -d UTILIZATION`) climb while a recording
   or broadcast runs.

### VAAPI (Intel / AMD iGPU or GPU)

1. A **render node** at `/dev/dri/renderD128` on the host.
2. Pass it into the worker container: `--device /dev/dri:/dev/dri` (and typically
   add the container user to the `render`/`video` group).
3. A worker image with **VAAPI** (`libva` + driver: `intel-media-va-driver` /
   `mesa-va-drivers`) built in.

If any of the above is missing the worker silently encodes on CPU — which is why
`hwaccelResolved` + the metrics below tell you what the **core requested**, while
`nvidia-smi`/`vainfo` on the node tell you what actually ran.

### Without a GPU

Do nothing. `GET /system/gpu` reports `type:"none"`, every app resolves to `cpu`,
and encoding uses software exactly as it does today. You can also hard-disable
detection with `GPU_DISABLE=true`.

---

## Metrics (Prometheus)

Two series are exported on `/metrics` (see `deploy/OBSERVABILITY.md`):

- `streamhub_media_transcode_total{kind,accel,type}` — counter of media ops by
  `kind` (`egress`|`ingress`), `accel` (`gpu`|`cpu`) and GPU `type`
  (`nvidia`|`vaapi`|`none`). This is the "did the last egress/ingress use gpu vs
  cpu" signal.
- `streamhub_gpu_available{type}` — gauge, `1` on the active type when a usable
  GPU is detected on the node, else `streamhub_gpu_available{type="none"} 1`.

Example queries:

```promql
# share of egress that ran on GPU in the last hour
sum(rate(streamhub_media_transcode_total{kind="egress",accel="gpu"}[1h]))
  / sum(rate(streamhub_media_transcode_total{kind="egress"}[1h]))

# nodes currently advertising an NVIDIA GPU
max(streamhub_gpu_available{type="nvidia"}) by (instance)
```

---

## Environment

| Var | Default | Meaning |
|-----|---------|---------|
| `TRANSCODING_HWACCEL` | `auto` | Global default hwaccel for apps without their own setting (`auto`\|`gpu`\|`cpu`). |
| `GPU_DISABLE` | `false` | `true` hard-disables detection; node reports `none` and always uses CPU. |
