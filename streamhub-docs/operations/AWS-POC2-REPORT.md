# AWS Deep PoC — Round 2 (2026-07-05)

Second, deeper AWS proof-of-concept, driven end-to-end through the AWS CLI, **installing every
node via the published landing one-liner** (`curl -fsSL https://www.streamhub.studio/install.sh | sudo bash`,
never a direct build). Complements [AWS-API-TEST-REPORT.md](./AWS-API-TEST-REPORT.md) (round 1).

> **Environment.** Shared account, region `us-east-1`, from the maintainer's CLI. The
> account also holds **12 unrelated production instances** (srv01.greenflame, mail-server, client
> apps). Hard rule this round: **every object tagged `Project=streamhub-poc2`; all destructive ops
> filter by that tag, never by state.** Nothing outside the tag was read or touched. Budget ceiling
> USD 25; **actual PoC spend ≈ USD 1** (6 instances, ~1–2 h).

---

## 1. Topology exercised

| Cluster | Nodes | Purpose |
|---|---|---|
| **A** | c5.xlarge origin + c5.large edge + t3.medium edge (3) | features-on-edge, mesh, failover, recording, observability |
| **B** | c5.large origin + t3.medium edge (2) | second parallel cluster (independence) |
| **GPU** | g4dn.xlarge **spot** (NVIDIA T4, ~$0.22/h) | NVENC transcode + CUDA inference |

Foundation (non-billable): one ed25519 key pair, two security groups (media ports + an
all-traffic **self-reference** so intra-cluster Redis/LiveKit talk over **private IPs, free**),
reused the round-1 Route 53 zone. Auto-assigned public IPs, `gp3` roots `DeleteOnTermination=true`,
**never** Elastic IPs.

---

## 2. Results — what passed

- **Landing one-liner install**: fresh install on both origins (Ubuntu 24.04) → all services
  healthy (`core`+`redis`+`livekit`+`ingress`+`egress`). ✅
- **Cluster join**: 3 edges registered in `/api/v1/cluster/nodes` (active, fresh heartbeats). ✅
- **2 real parallel clusters** with shared Redis — after the fix in §3. ✅
- **API surface** (all `/api/v1`, resource cycle): `apps` create/get/delete, `POST ingress`
  (returns `rtmp_url`+`stream_key`), `streams`, `cluster/nodes`, `plugins`(+`/public`), `s3` config,
  `vods`. ✅
- **RTMP ingest → live stream** on the origin (ffmpeg → ingress:1935 → LiveKit room `active`). ✅
- **Features-on-edge** (round-1 gap, now closed): ingress created via the **origin** API, RTMP
  pushed to an **edge's** ingress → the origin core sees the stream `active` cluster-wide. ✅
- **Failover**: stopping an edge's heartbeat flips it to `stale=true` after ~90 s while origin +
  the other edge stay fresh. ✅
- **GPU / NVENC** (T4): single 1080p→720p **6.9× realtime** (208 fps) vs libx264 4.5×; **8 parallel
  NVENC transcodes ≈1.5× each** (~12× aggregate) — the ceiling is the box's 4 vCPUs doing software
  decode, not NVENC. A ~$0.22/h spot T4 is a viable transcode node. ✅
- **S3 config**: `PUT /apps/:app/s3 {provider:"aws", endpoint:""}` auto-clears the scaffold Wasabi
  endpoint (round-1 fix present); recording **egress starts and records** (Chrome START/END). ✅
- **Observability**: Prometheus+Grafana stood up on the origin, both targets UP, `streamhub_*` +
  `livekit_*` scraped, dashboard provisioned. See [OBSERVABILITY.md](./OBSERVABILITY.md) §4. ✅

Resource note (G2): a c5.xlarge origin running the full stack under a transcode load sat at
**~1.3 GB / 7.6 GB RAM**; `ingress` (RTMP transcode) is the CPU hot spot. The stack is lean;
egress (headless Chrome) is the real RAM lever for concurrent recordings.

---

## 3. Findings (new, empirically reproduced)

| # | Severity | Finding | Fix / status |
|---|---|---|---|
| 1 | High | **Documented cluster join is broken.** `--join --origin-ip <ip>` builds `http://<ip>:3020`, but core binds **`127.0.0.1:3020`** (only nginx is on `:80`) → join `curl` `Couldn't connect`. | Workaround used: `--origin-url http://<ip>` (proxy :80). Installer/day-1 docs must default the join target to the proxy, not `:3020`. |
| 2 | High | **Cluster media plane broken by default.** Origin `redis` binds `127.0.0.1:6379`; joined edges are handed `redis://<origin>:6379` → every edge's LiveKit/ingress/egress **crash-loops** (`connection refused`). Control plane (registry+heartbeat) works; media never comes up. | **Found + fix validated live:** bind origin redis to the private IP (already SG-scoped) → all edges recover and join the shared Redis. Origins must install with redis on the private interface for a real cluster (a `--cluster-redis-bind` flag exists but the plain/default origin install doesn't apply it). |
| 3 | Medium | **Cross-node egress placement.** In a shared-Redis cluster the `stopEgress` RPC routes to the wrong node → twirp **timeout**; VOD stays `recording`, no S3 upload (room hosted on one LiveKit node, egress worker on another). Single-node recording works (round 1). | Structural — needs egress-direct-to-S3 or shared storage / room-pinned egress. Documented as open. |
| 4 | Low (UX) | **Stream sub-routes key off `streamId`, not the numeric `id`.** `record/start` + `hls/start` resolve `:id` as the `stream_id` string (`"room/participant"`, contains `/` → must be URL-encoded); passing the natural numeric `id` from the list → 404. | Consider accepting the numeric id, or documenting the encoded-`streamId` contract prominently. |

---

## 4. Cost & teardown discipline

- Time-boxed; GPU + 3 edges terminated as soon as their tests passed; origins kept only for the
  observability + installer-upgrade validation, then destroyed.
- Ordered teardown by **tag** (`teardown.sh`): terminate instances (volumes auto-delete) → delete
  security groups (retry until ENIs release) → key pair → empty+delete S3 buckets → delete scoped
  IAM user/keys → **final audit query proving zero `streamhub-poc2` resources** (instances, volumes,
  snapshots, AMIs, SGs, key pairs, spot requests, ENIs, buckets, IAM users).
- Recurring after teardown: only the round-1 Route 53 zone (~$0.50/mo).

---

## 5. Installer upgrade path (v2.1 → v2.2, tested on a live box)

Re-running the new installer against an existing install correctly **detected the legacy version
(0.0.0)**, took a **pre-upgrade backup** of all SQLite DBs (`backups/<UTCstamp>-v0.0.0/`), and
stamped `VERSION=2.2.0`. The full rebuild then **failed at the Python worker layer** (`pip install
torch` for deface/yolo, exit 1 — a network/build flake), so the core did not restart with the new
code and migration #9 did not apply (`user_version` stayed 8). Verdict: **upgrade mechanics
(detect → backup → version) validated; the worker image build is a fragility to harden** (prebuilt
worker images, or make the worker layer optional/retry). See [stabilization notes](./STABILIZATION.md).
