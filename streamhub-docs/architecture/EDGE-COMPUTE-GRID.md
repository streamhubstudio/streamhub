# StreamHub Grid — bring-your-own-GPU edge compute

**Goal.** Add remote GPU machines — behind NAT, outside the server's network, on reused ethereum-mining cards — to
the cluster as **compute** nodes that offload YOLO / Vision One models / transcoding / plugin workers from the media
server. Encrypted, churn-tolerant, private. Think "vast.ai / Salad, but a private pool running *your own* models
(Vision One) and configs."

## Verdict

**Feasible — for COMPUTE offload, not for serving live viewers.** The pull-based + outbound-agent + encrypted-overlay
pattern is proven at scale (Salad 1M+ nodes, io.net, Aethir on consumer RTX) and — crucially — **Vision One is already
a VRAM-sized master/slave GPU cluster**, and StreamHub already has a node registry + heartbeat + capacity. The Grid is
those two, made NAT-safe and churn-tolerant. The one thing that does **not** work through NAT is a live SFU edge that
*serves* viewers (that needs a public IP); delivery stays on the origin + CDN.

## 1. Connectivity / NAT — the crux, and it's solved

A NAT'd machine has no public IP and no port-forwarding, so it must **initiate outbound** connections. Two channels:

- **Control** — the agent holds a persistent outbound WSS/gRPC to the coordinator (exactly how StreamHub's cluster
  heartbeat, GitHub self-hosted runners and Salad nodes work). Jobs are pushed down it.
- **Media** — reaches the agent by **pull**, which is inherently NAT-friendly:
  | Workload | Pull source (outbound) |
  |---|---|
  | Vision One occupancy | HLS (`cv2.VideoCapture` FFmpeg) — *already does this* |
  | Crowd / demography | camera snapshots over HTTPS |
  | People counting | recorded mp4s from per-app S3 |
  | Sub-second | WHEP / WebRTC (ICE/STUN/TURN traverse NAT) |

**Overlay mesh** (self-hosted WireGuard — Netbird / Nebula / headscale) is the clean unifier: agents join a private
encrypted network with **no open ports**, NAT hole-punching + a relay fallback are handled by the mesh, and every node
"appears on the LAN." This also fixes Vision One's current master→slave design, which polls the slave's
`/cluster/health` (master → slave, needs the slave reachable): over the mesh the master reaches the "slave" as if local,
so **no code change to Vision One's cluster is required** — just run it over the overlay.

## 2. Security

- **Identity**: per-agent revocable token → mTLS (extend the cluster `X-Cluster-Token` to per-agent certs).
- **In transit**: WireGuard (ChaCha20-Poly1305) end to end; media pulled over HTTPS / DTLS-SRTP.
- **At rest**: no persistence on the node — ephemeral frames, encrypted scratch, wipe on job end.
- **Trust boundary**: a compute node must **decrypt frames to run YOLO**, so true zero-knowledge E2EE is incompatible
  with it. Therefore the Grid is a **private pool of machines you control** (home / office / trusted peers), not a
  public marketplace. Mitigate residual risk by routing only non-sensitive streams to lower-trust nodes, per-tenant.

## 3. Reusing old mining GPUs — real

- **Ampere ex-miners** (RTX 3060 12GB / 3070 / 3080 / **3090 24GB**): excellent for YOLO/Vision One inference (CUDA,
  tensor cores, good VRAM — a 3090 runs several models). Ideal.
- **Mining-only cards** (P106-100, CMP): no display output but CUDA works → headless inference fine, older arch / low
  VRAM → lighter models (YOLO n/s).
- **AMD** (RX580…): ROCm / onnxruntime-DirectML, finicky → light use.
- **Transcode**: consumer GPUs now allow **up to 8 concurrent NVENC sessions** (driver-only since Jan 2024, no hack);
  inference has **no session cap**. So a reused 30-series offloads real transcode + unlimited inference.
- **Reality checks**: home power cost, heat, and flaky power/internet → nodes churn. Handle it (see §4).

## 4. Scheduling — mostly already built

- **StreamHub cluster**: `nodes` registry + heartbeat + `stats_json` capacity + `status` (active/draining/disabled)
  (see [CLUSTER-2NODE-TEST.md](../operations/CLUSTER-2NODE-TEST.md)).
- **Vision One**: `LoadBalancer` sizes `max_streams` from free VRAM, weighted-round-robin assignment, failback with
  grace, idempotent people-counting DB writes → **churn-safe by design**.
- **The Grid router** = those two, extended: agent-initiated registration (NAT), capacity-aware (GPU model / VRAM /
  TFLOPS), region/latency-aware, and job-typed (which model · camera · transcode). Reassign on stale heartbeat.

## 5. What runs on the Grid (and what doesn't)

| ✓ Fits (pull + push) | ✗ Doesn't fit through NAT |
|---|---|
| Vision One occupancy / people-counting / crowd / demography | Live SFU edge **serving** viewers (needs inbound public UDP 7882) |
| YOLO + any `needsWorker` plugin | Being a public CDN edge (needs inbound) — do the *compute*, deliver via Bunny/CDN |
| Transcode / ABR ladder (NVENC) → push HLS to origin/S3 | |
| VOD / recording post-processing (async, idempotent) | |
| Egress/recording (pull WHEP → record → S3) | |

"Process CDN": the Grid can pre-transcode / package content for a CDN, but public delivery stays on a real edge
(Bunny/Cloudflare) or a P2P layer — a NAT node can't be a public cache.

## 6. vs vast.ai / Salad

Those are **public marketplaces** renting strangers' GPUs to run arbitrary containers. The Grid is a **private** pool
of **your** machines running **your** models (Vision One) and configs, integrated with StreamHub jobs — simpler trust,
tighter integration, no rental cost. Closer to a self-hosted Salad or a folding@home for your CCTV analytics.

## Phased plan

1. **P1 — Agent + mesh (M).** Compute agent (Docker/binary) + self-hosted WireGuard overlay + outbound capacity
   heartbeat into the cluster registry. Prove it with **one job**: Vision One occupancy on a remote/NAT GPU pulling
   StreamHub HLS, events back via HMAC webhook → dashboard overlay.
2. **P2 — Grid router (L).** Capacity/region/trust-aware, churn-tolerant job assignment across agents (fold in Vision
   One's balancer). Job types: vision models, transcode, VOD.
3. **P3 — Transcode/VOD offload (M).** Move the ABR ladder + recording post-processing to Grid nodes (NVENC), relieving
   the origin (ties to the G2 track-egress recommendation in [CAPACITY-G2.md](../operations/CAPACITY-G2.md)).
4. **P4 — Fleet UX (M).** One-liner agent install (like the node installer), a Grid tab in the dashboard (GPUs, jobs,
   health), revocable tokens.

**Bottom line:** a private, encrypted, NAT-friendly GPU grid is realistic because the workloads are pull-based and the
scheduler mostly exists (StreamHub cluster + Vision One balancer). It turns spare/old GPUs into cheap parallel capacity
for exactly the AI features on the roadmap.
