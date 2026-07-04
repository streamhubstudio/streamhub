# AWS API Test Report — StreamHub proof-of-concept (2026-07-03)

Executive report of the StreamHub validation carried out **on AWS, driven entirely through the AWS
API/CLI**. It complements [AWS-POC.md](./AWS-POC.md) (the reproducible command runbook) — this document
is the narrative + results + the operating decisions behind it.

> **Environment note.** All AWS work ran in account `123456789012`, region `us-east-1`, from the AWS CLI
> on the maintainer's workstation. That account also holds **unrelated production** resources, so every
> object created for these tests was tagged `Project=streamhub-poc` (and `…-sec` for the security round)
> and nothing outside those tags was read, modified, or deleted.

---

## 1. Scope and headline result

Three independent proofs-of-concept, each **created → tested → certified → destroyed** in a single
session, plus a security/DoS round (documented separately in the security report):

| PoC | What it proved | Runtime | Cost |
|---|---|---|---|
| **5-node cluster** | Media mesh across 5 LiveKit nodes; per-instance-size capacity certification | 50 min | ~$0.33 |
| **GPU (NVIDIA T4)** | NVENC transcode throughput + CUDA inference for the CV workers | 45 min | ~$0.19 |
| **S3 recording loop** | Per-app recording → real S3 bucket → VOD → presigned playback | 22 min | ~$0.06 |
| **(security round)** | Authorized API pentest + DoS baseline (see `AWS-SECURITY-REPORT.md`) | — | ~$2 est |

**Total spend for the PoCs: ~USD 0.58** against a USD 50 ceiling. **Final audit: zero billable resources
left running** (independently re-verified — instances, EBS volumes, snapshots, AMIs, security groups, key
pairs, network interfaces, spot requests, S3 buckets, IAM users all clear).

---

## 2. Did we test the installer or a direct build?

**The published installer, every time — never a direct `docker build` / `npm build`.**

Every instance was provisioned with the one-liner exactly as an end user would run it:

```bash
curl -fsSL https://www.streamhub.studio/install.sh | sudo bash -s -- --non-interactive --no-tls [flags]
```

The installer pulls the source tarball published at `https://www.streamhub.studio/streamhub-src.tar.gz`
(kept byte-in-sync with the repo HEAD) and builds on the box. This was a deliberate choice — dogfooding
the real install path — and it paid off: it surfaced **five packaging/deploy bugs that a direct build
would have hidden**, all since fixed (see §6). No test used a hand-built image or a bind-mounted working
tree.

---

## 3. Were all features tested on the cluster?

**Partially — and this is called out honestly.** The cluster rounds (OVH node01+node02, and the AWS
5-node) exercised the **cluster mechanics** thoroughly at scale: node registration, media mesh, room
distribution across every LiveKit, drain, and node-failure re-allocation. The **application features**
shipped this cycle (deface, MQTT, active sessions, conference sample) were validated against the
**origin node**, which was cluster-configured but not exercised with each feature while its room lived on
a *remote* node.

That remaining gap — **features when the room is hosted on an edge, not the origin** — is being closed in
the security/cluster round (`AWS-SECURITY-REPORT.md`, Part 1), because it intersects the one open
structural limitation: **cross-node egress placement** (recording/HLS jobs can be claimed by the wrong
node's egress worker, landing files on that node's disk ~50% of the time). Sessions and the conference
sample are core-only and node-agnostic; deface and recording are the ones sensitive to room placement.

---

## 4. What was built through the AWS API

Everything below was orchestrated with `aws` CLI calls — no console clicking:

- **Compute** — `ec2 run-instances` for on-demand nodes and `ec2 request-spot-instances`
  (one-time, max = on-demand) for the GPU box; AMIs resolved live from the SSM public parameter
  `/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id` (no hardcoded AMI
  IDs); `gp3` roots with `DeleteOnTermination=true`; **auto-assigned public IPs, never Elastic IPs**
  (so nothing survives termination to bill silently).
- **Network** — `ec2 create-security-group` + `authorize-security-group-ingress` opening only the media
  ports (80, 1935, 8080, 7880–7882 tcp+udp, 22) plus an **all-traffic self-reference** so intra-cluster
  Redis/LiveKit talk over **private IPs (free)**; `ec2 create-key-pair` (PEM to the scratchpad, `chmod 600`).
- **GPU enablement** — driver install + `nvidia-container-toolkit`; `docker-compose` `gpus: all` grant
  validated by the app's own `GET /api/v1/system/gpu` probe.
- **Storage / identity** — `s3api create-bucket` (public access fully blocked); a **scoped IAM user**
  (`iam create-user` + inline policy limited to that one bucket) whose keys were used only at runtime in
  the app's S3 config — **the account-root keys never left the workstation**.
- **Quotas** — `service-quotas get-service-quota` to confirm G/VT vCPU headroom before launching the GPU
  instance (768 on-demand / 64 spot — no increase needed).
- **Teardown + audit** — `ec2 terminate-instances` → `describe-volumes`/`describe-instances` tag filters
  to prove deletion; `s3 rm --recursive` + `s3api delete-bucket`; `iam delete-access-key`/`delete-user`.
- **DNS (kept)** — `route53domains register-domain` for `example-nodes.click` (USD 3/yr, WHOIS privacy
  on all three contacts) so future AWS nodes can get real DNS + Let's Encrypt automatically. Its hosted
  zone (`ZEXAMPLE00000000000`, USD 0.50/mo) is the **only** recurring AWS cost left.

---

## 5. Results

### 5.1 Cluster (5 nodes: c5.xlarge origin + t3.small / t3.medium / t3.large / c5.large edges)
- All 5 registered; heartbeats fresh; staleness correctly flips >90 s after a node stops beating.
- **Media mesh PASS**: 5 RTMP streams ingested into 5 different nodes → rooms distributed across **all 5**
  LiveKits; WebRTC playback verified from 4 different owning nodes; HLS 200.
- 15 simultaneous streams placed 4 / 5 / 2 / 2 / 2 across the nodes; 10 viewers on a t3.small-owned room
  held 13–15 fps.
- **Failover**: hard-stopping an edge hosting 7 rooms re-allocated all 7 to survivors in <2 min; only
  publishers ingesting through that edge's *local* ingress dropped (ingest is pinned — no failover).
- **Per-size certification**: only nodes with **≥4 vCPU** can run room-composite HLS/recording (egress
  `minimumCpu:4`); a c5.xlarge sustains ~1 concurrent composite (~1.5 GB RSS / ~3 vCPU). A t3.small
  reliably serves ~5–6 ingest sessions and collapses around 12; pure room-serving is cheap (LiveKit ~5%
  CPU with 10 viewers).

### 5.2 GPU (g4dn.xlarge, NVIDIA T4, spot @ ~$0.234/hr)
- **NVENC**: single 3-rung ladder at 4.6× realtime (vs libx264 2.12×); **10 simultaneous 1080p→720p
  NVENC transcodes each ≥1.67× realtime at only 42% GPU util** — the ceiling was the 4 vCPUs doing
  software decode, not NVENC (session cap is genuinely gone).
- **deface / CenterFace (CUDA)**: 12.0 ms/frame @640×360 vs 52.1 ms CPU (~10× on raw ONNX inference);
  `CUDAExecutionProvider` confirmed active, and the `cuda=true`→CPU graceful fallback verified.
- **yolov8n**: 8.9 ms/frame CUDA vs 59.4 ms CPU (~113 fps).
- Verdict: a single ~$0.23/hr spot T4 is comfortably viable as a transcode/analytics node.

### 5.3 S3 recording loop (c5.xlarge standalone)
- `PUT /apps/:app/s3 {provider:"aws", bucket, region, endpoint:"", key, secret}` → RTMP stream → record
  → VOD `ready` → object present in the bucket → presigned URL 200 → valid H.264+AAC MP4.
- Credentials masked on read; keys stored in `data/secrets.json`, never the versioned config.
- **Bug found & fixed**: a fresh app defaults its S3 endpoint to Wasabi; `provider:"aws"` without an
  explicit `endpoint` used to keep it, silently sending uploads to Wasabi with AWS creds. Now
  provider `aws` with no endpoint auto-clears it to the SDK regional default (fix `58de693`).

---

## 6. Findings → fixes (all merged to `main`)

| # | Found via | Fix | Commit |
|---|---|---|---|
| 1 | 5-node install on 2-vCPU edges | `EGRESS_CPUS` clamped to `min(4,nproc)` — joins no longer die | `0d9923b` |
| 2 | `--no-tls`/IP installs | Real no-TLS mode (`http://`/`ws://` URLs, nginx catch-all, Caddy plain HTTP) | `0d9923b` |
| 3 | Nodes went stale after 90 s | Installer ships a heartbeat systemd timer; origin self-registers | `0d9923b` |
| 4 | Drain reverted by heartbeat | Heartbeat preserves operator status (`draining`/`disabled`) | `0d9923b` |
| 5 | S3 loop on AWS | `provider:"aws"` auto-clears the scaffold Wasabi endpoint | `58de693` |
| 6 | GPU box: no ffmpeg in image | Core image now ships ffmpeg (NVENC-ready) + documented `gpus: all` | `3ab4ced` |

**Open (structural, roadmap):** cross-node egress placement — recording/HLS can land on the wrong node's
disk in a cluster; the real fix is egress-direct-to-S3 output or shared storage.

---

## 7. Cost & teardown discipline

- **Never** Elastic IPs (auto-assigned public IPs die with the instance).
- Intra-cluster traffic over private IPs (free), gated by a self-referencing security group.
- Hard time-boxes per agent; teardown runs even on failure.
- Ordered teardown: terminate instances (volumes auto-delete) → security groups → key pairs → empty +
  delete buckets → delete IAM keys/user → **final audit query proving zero resources under the tag**.
- Cost accounting per test (instance-hours × on-demand/spot rate + EBS-hours).

**Recurring after teardown:** only the `example-nodes.click` Route 53 hosted zone (~$0.50/mo) and the
domain renewal (~$3/yr). Everything compute/storage is gone.

---

## 8. Security note on the credentials used

The workstation's AWS credentials are the **account root** access keys. That worked for the tests, but
it is the single biggest risk in this setup: a leaked root key is unscoped, unrevocable-in-part account
takeover. **Recommendation:** migrate CLI usage to an IAM user (or IAM Identity Center / SSO) with a
least-privilege policy and disable the root access keys. The test IAM user we created for S3 was already
scoped this way as the pattern to follow.

---

_See [AWS-POC.md](./AWS-POC.md) for the copy-pasteable command runbook, and `AWS-SECURITY-REPORT.md` for
the authorized pentest / DoS results and the cross-node feature matrix._
