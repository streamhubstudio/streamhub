# Vision Edge — sizing & pricing

How to dimension a Vision Edge deployment: how many cameras / streams a node
handles, how much bandwidth it moves, and what it costs per month on AWS /
DigitalOcean / Azure. An interactive calculator ships inside the **vision Studio
App** (Sizing tab); this doc is the data behind it.

> **Provenance — read this before quoting a customer.**
> - **MEASURED**: the per-model GPU throughput + VRAM and the GPU aggregate
>   ceiling were benchmarked on a real **Tesla T4** (AWS g4dn.xlarge, FP16,
>   process-isolated — one model per subprocess, matching the edge supervisor).
> - **ESTIMATED**: other GPUs are scaled from the T4 by relative FP16 throughput
>   with a conservative 0.65 efficiency factor (batch-1 inference is latency- and
>   memory-bandwidth-bound, NOT linear with peak TFLOPS). Treat as **±30 %**.
> - **APPROXIMATE**: cloud prices are ~2026 on-demand list (USD/hour). They drift
>   and vary by region/commitment — **verify before quoting**.

## Measured GPU capacity (Tesla T4, FP16)

| Model | Weights + tracker | Per-process FPS | VRAM | Nature |
|---|---|---|---|---|
| Occupancy | yolo11m + ByteTrack, imgsz 640 | **77** | 101 MB | realtime track |
| People counting | yolo11m + BoT-SORT, imgsz 640 | **76** | 101 MB | realtime track |
| Presence | yolo11n | 28–42 | 51 MB | realtime track |
| Crowd | yolo11m detect, imgsz 960 | 72 | 128 MB | **snapshot** (1 frame / ~30 s) |
| Demographics | InsightFace buffalo_l | 7.4 | ~1.5 GB | **snapshot** (1 frame / ~120 s) |

**GPU aggregate ceiling** (occupancy, yolo11m + ByteTrack): concurrency is
**process-based** in production (the supervisor spawns one subprocess per
assignment, no shared Python GIL). Measured aggregate throughput SATURATES at
**~145 FPS** on the T4 — beyond ~3 concurrent processes, adding more just divides
that fixed ceiling:

| Concurrent occupancy procs | Aggregate FPS | Per-stream FPS |
|---|---|---|
| 1 | 76 | 76 |
| 2 | 128 | 64 |
| 3 | 145 | 48 |
| 4 | 131 | 33 |
| 6 | 146 | 24 |

## How "max cameras per GPU" is computed

`cameras/GPU = min(throughput-bound, VRAM-bound)`:
- **throughput** = `GPU aggregate FPS ÷ required cadence FPS per camera`.
- **VRAM** = `(VRAM − 500 MB reserve) ÷ per-camera VRAM` (the scheduler's formula).

The **cadence** dominates. A realtime tracker does NOT infer every frame —
Vision One's occupancy samples to ~3.5–4 effective FPS. So on a T4:

| Cadence | Cameras / T4 (occupancy) | Bound |
|---|---|---|
| 4 fps (sampled, like Vision One) | **~36** | throughput |
| 15 fps | ~9–10 | throughput |
| 25 fps (near-full) | ~6 | throughput |

Snapshot models (crowd/demography) barely touch throughput (tiny cadence) — they
are VRAM-bound (demography's 1.5 GB InsightFace footprint is the real limit).

## Node roles & their limits

- **Agent** (in the camera LAN): restreams each camera RTSP → RTMP with `-c copy`
  (no transcode) — CPU is near-zero; the limit is **bandwidth and camera count**
  (one ffmpeg bridge per camera, ~0.1 vCPU each). A 2-vCPU box handles dozens.
- **Master** (StreamHub core): passthrough ingest is near-free (~0.1 vCPU/stream,
  bandwidth-bound). **Transcode** (the LiveKit path) is CPU-heavy —
  MEASURED **3 × 1080p 3-layer ≈ 8 vCPU (~100 % of an 8-core box)**; single-layer
  ≈ 1 vCPU/stream. So the master is sized by the ingest mode, not the models.
- **Edge (GPU)**: sized by the table above — GPUs needed =
  `ceil(cameras ÷ cameras-per-GPU)`.

## Bandwidth

Per continuous **1 Mbps ≈ 329 GB/month**. Typical H.264 bitrates: 1080p 4.5,
720p 2.5, 480p 1.2 Mbps. Ingress = Σ camera bitrates. Egress is billed only for
**viewers** pulling HLS (the edge's internal pull is not egress); vision-only
deployments (0 viewers) have ~0 egress cost.

## Approximate cloud prices (~2026, USD/hour on-demand — verify)

| Provider | GPU (edge) | $/hr | CPU (master/agent) | $/hr | Egress $/GB |
|---|---|---|---|---|---|
| AWS | g4dn.xlarge (T4) | 0.526 (spot ~0.22) | c6i.xlarge (4 vCPU) | 0.17 | 0.09 |
| AWS | g6.xlarge (L4) / g5.xlarge (A10G) | 0.805 / 1.006 | c6i.2xlarge (8 vCPU) | 0.34 | 0.09 |
| DigitalOcean | GPU L40S (1×) | 1.57 | Droplet 4 vCPU/8 GB | 0.071 ($48/mo) | **0.01** (1 TB incl.) |
| Azure | NC4as T4 v3 (T4) | 0.526 | F4s v2 (4 vCPU) | 0.169 | 0.087 |
| Azure | NV6ads A10 v5 (A10G) | 0.908 | — | — | 0.087 |

**Worked example** — 20 × 1080p occupancy cameras, T4, passthrough, no viewers,
AWS: 1 × g4dn (20 < ~36 cams/T4) ≈ **$384/mo GPU** + a small master ≈ **$124/mo**
+ ~$0 egress = **~$508/mo** (on-demand; ~$160 GPU with spot). DigitalOcean egress
is ~9× cheaper if you serve many viewers.

## Notes & limits of the model
- The T4 is the only MEASURED GPU; others are extrapolated (±30 %) — benchmark
  your target GPU before committing to tight per-GPU camera counts.
- Numbers are for the shipped **yolo11m** occupancy model; a lighter/heavier
  detector shifts throughput proportionally.
- Vehicle occupancy/counting cost ≈ persons (same detector); demographics with an
  external AI-API (OpenAI/DeepSeek) is priced per-call, not per-GPU — out of this
  model.
- Re-run `vision-edge-testbed/bench_v2.py` on a fresh box to refresh the numbers.
