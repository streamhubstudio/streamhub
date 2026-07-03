# AWS EC2 proof-of-concept — cluster, GPU transcode, S3 recording

**Date:** 2026-07-03. **Region:** `us-east-1`. **Total spend:** ~$0.58 of a $50 budget across
three time-boxed PoCs. **Account-agnostic:** this doc contains no account IDs, no real IPs, and
no AMI IDs (resolved live via SSM) — every command is copy-pasteable against any AWS account.

This validates on **real cloud VMs** the cluster control-plane + media-mesh design across 5 nodes of mixed
instance sizes, and adds two things not covered elsewhere: GPU transcode numbers on a real
NVIDIA T4, and a full S3 recording round-trip against real AWS S3 (not Wasabi/MinIO).

| PoC | What | Cost | Wall time |
|---|---|---|---|
| A | 5-node cluster (1 origin + 4 edges), media mesh, load + failover | ~$0.33 | 50 min |
| B | GPU transcode + CV inference on `g4dn.xlarge` (NVIDIA T4, spot) | ~$0.19 | 45 min |
| C | S3 recording round-trip against real AWS S3 + scoped IAM | ~$0.06 | 22 min |

---

## Methodology

**Goal:** certify per-size capacity by actually loading each instance size to its ceiling, not
by reading the spec sheet — this is the same "measure, don't guess" discipline as
[`LATENCY-TUNING.md`](./LATENCY-TUNING.md), applied to
cloud instance sizing and GPU offload instead of a single fixed production box.

Rules followed for all three PoCs:

1. **Tag everything** `Project=streamhub-poc` at creation time (instances, security groups,
   key pairs, IAM user, S3 bucket) — this is both the cost-allocation tag and the teardown
   query.
2. **No Elastic IPs.** Auto-assigned public IPs are used and die with the instance — nothing
   persists after teardown, nothing to remember to release.
3. **Intra-cluster traffic over private IPs**, gated by a **self-referencing security group**
   (source = the SG itself) — no cluster port is ever exposed to the internet.
4. **Resolve the AMI live via SSM** (Canonical's public parameter), never hardcode an AMI ID —
   AMI IDs are region- and rotation-specific and go stale.
5. **Spot for the GPU instance** (on-demand for everything else — the cluster/S3 PoCs are short
   and latency-sensitive to interruption; GPU benchmarking tolerates a spot reclaim mid-run).
6. **Hard time-box per PoC** (tracked wall-clock above) — instances are launched right before
   the test starts and terminated the moment results are captured.
7. **Teardown discipline**: every resource created is deleted in reverse order, then an
   **audit** query against the tag confirms zero resources remain (commands in
   [Teardown & audit](#teardown--audit) — run this even if a step above already deleted
   something, it's idempotent and cheap).
8. **Cost accounting per test**, reported above and re-stated in each section.

### Common setup

```bash
export AWS_REGION=us-east-1
export TAG=streamhub-poc

# 1. Resolve the current Ubuntu 24.04 LTS amd64 AMI via SSM (no hardcoded AMI ID)
AMI_ID=$(aws ec2 describe-images --owners 099720109477 \
  --filters "Name=name,Values=ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*" \
             "Name=state,Values=available" \
  --query 'sort_by(Images,&CreationDate)[-1].ImageId' --output text --region "$AWS_REGION")
# equivalent, preferred when the SSM public parameter is reachable in-account:
AMI_ID=$(aws ssm get-parameters --region "$AWS_REGION" \
  --names /aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id \
  --query 'Parameters[0].Value' --output text)

# 2. Default VPC + its default subnet (fine for a short-lived PoC)
VPC_ID=$(aws ec2 describe-vpcs --region "$AWS_REGION" \
  --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)
SUBNET_ID=$(aws ec2 describe-subnets --region "$AWS_REGION" \
  --filters "Name=vpc-id,Values=$VPC_ID" --query 'Subnets[0].SubnetId' --output text)

# 3. Key pair
aws ec2 create-key-pair --region "$AWS_REGION" --key-name "$TAG" \
  --tag-specifications "ResourceType=key-pair,Tags=[{Key=Project,Value=$TAG}]" \
  --query 'KeyMaterial' --output text > "$TAG.pem"
chmod 400 "$TAG.pem"

# 4. Security group — public StreamHub ports + SSH, plus a self-referencing rule
#    for private cluster traffic (redis 6379, and node-to-node media for the mesh test)
SG_ID=$(aws ec2 create-security-group --region "$AWS_REGION" \
  --group-name "$TAG" --description "streamhub-poc, tear down same day" --vpc-id "$VPC_ID" \
  --tag-specifications "ResourceType=security-group,Tags=[{Key=Project,Value=$TAG}]" \
  --query GroupId --output text)
```

**Port list** — the same set `install.sh` preflights on every node
([`INSTALL-NODE.md`](./INSTALL-NODE.md)):

| Port | Proto | Purpose | Exposure |
|---|---|---|---|
| 22 | tcp | SSH | public (PoC only — scope to your IP in anything longer-lived) |
| 80, 443 | tcp | HTTP / HTTPS (Caddy or nginx+certbot) | public |
| 1935 | tcp | RTMP ingest | public |
| 7880 | tcp | LiveKit WebSocket signaling (`/rtc`, proxied) | public |
| 7881 | tcp | LiveKit ICE-TCP fallback | public |
| 8080 | tcp | WHIP ingest | public |
| 7882 | udp | LiveKit WebRTC media | public |
| 3020 | tcp | core (behind the proxy; loopback in practice) | **not opened** — reachability, not exposure, is what `install.sh` preflights |
| 6379 | tcp | Redis (cluster coordination) | **private only** — self-referencing SG, never public |

```bash
for rule in "tcp 22" "tcp 80" "tcp 443" "tcp 1935" "tcp 7880" "tcp 7881" "tcp 8080"; do
  set -- $rule
  aws ec2 authorize-security-group-ingress --region "$AWS_REGION" --group-id "$SG_ID" \
    --protocol "$1" --port "$2" --cidr 0.0.0.0/0
done
aws ec2 authorize-security-group-ingress --region "$AWS_REGION" --group-id "$SG_ID" \
  --protocol udp --port 7882 --cidr 0.0.0.0/0

# Intra-cluster only: any node in this SG can reach redis on any other node in this SG.
aws ec2 authorize-security-group-ingress --region "$AWS_REGION" --group-id "$SG_ID" \
  --protocol tcp --port 6379 --source-group "$SG_ID"
```

```bash
# 5. Launch skeleton (repeat per node; no Elastic IP — auto-assigned public IP only)
aws ec2 run-instances --region "$AWS_REGION" \
  --image-id "$AMI_ID" --instance-type <TYPE> \
  --key-name "$TAG" --security-group-ids "$SG_ID" --subnet-id "$SUBNET_ID" \
  --associate-public-ip-address \
  --block-device-mappings '[{"DeviceName":"/dev/sda1","Ebs":{"VolumeSize":30,"VolumeType":"gp3","DeleteOnTermination":true}}]' \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Project,Value=$TAG},{Key=Name,Value=<NAME>}]" \
  --count 1 --query 'Instances[0].InstanceId' --output text
```

`DeleteOnTermination:true` on the root volume means **terminating the instance is sufficient**
to reclaim compute + storage — no separate EBS cleanup step.

---

## PoC A — 5-node cluster (~$0.33, 50 min)

**Topology** — 1 origin + 4 edges spanning the size range, all `us-east-1`, same VPC/subnet:

| Node | Instance type | vCPU / RAM | Role |
|---|---|---|---|
| origin | `c5.xlarge` | 4 / 8 GB | master — core + redis + nginx + livekit + ingress + egress |
| edge-s | `t3.small` | 2 / 2 GB (burstable) | edge — livekit + ingress + egress only |
| edge-m | `t3.medium` | 2 / 4 GB (burstable) | edge |
| edge-l | `t3.large` | 2 / 8 GB (burstable) | edge |
| edge-c | `c5.large` | 2 / 4 GB | edge |

All via the **published one-liner installer**
(`https://www.streamhub.studio/install.sh` — see [`INSTALL-NODE.md`](./INSTALL-NODE.md)).

```bash
# Origin — non-interactive, no TLS (bare IP, PoC only), redis bound to the private IP
# so edges can reach it without a public redis
curl -fsSL https://www.streamhub.studio/install.sh | sudo bash -s -- \
  --non-interactive --no-tls \
  --domain <origin-public-ip> \
  --cluster-redis-bind <origin-private-ip>
# summary prints the cluster token (clt_...) — capture it for the joins below

# Each edge — join by token, pointed at the origin's private IP
curl -fsSL https://www.streamhub.studio/install.sh | sudo bash -s -- \
  --join \
  --master-token <clt_...> \
  --master-ip <origin-private-ip> \
  --master-url http://<origin-private-ip> \
  --node-name <edge-s|edge-m|edge-l|edge-c>
```

Verify registration: `GET /api/v1/cluster/nodes` (Bearer `sk_` token from the origin) — all 5
nodes registered as `active`, `stale:false`.

### Results

**Media mesh — PASS.** 5 concurrent RTMP publishes, one per node; rooms distributed across
**all 5** LiveKit instances (confirmed via the shared-redis `room_node_map`); WebRTC playback verified from 4 different node owners;
HLS playback returned `200` for rooms whose egress landed on the same node as the room (cross-node recording is a known gap, unchanged by this PoC).

**Load — 15 simultaneous streams**, placement chosen by LiveKit's own load-based allocator (no
StreamHub-side steering yet):

| Node | Streams placed |
|---|---|
| origin (c5.xlarge) | 4 |
| edge-c (c5.large) | 5 |
| edge-s (t3.small) | 2 |
| edge-m (t3.medium) | 2 |
| edge-l (t3.large) | 2 |

**10 simultaneous viewers** on a room hosted on the `t3.small` edge: stable playback at
**13–15 fps**.

**Failover — hard-stop of an edge holding 7 rooms:**

- Rooms **re-allocated to a live node in under 2 minutes**, playback resumed. ✅
- **Publishers ingesting through the killed edge's local ingress died and did not fail over** —
  ingest is pinned to the node the RTMP/WHIP session opened on; there is no ingest-session
  failover today. A publisher must reconnect against a live node (a DNS/LB layer in front of
  the fleet is a production prerequisite, not something StreamHub does for you). This is the
  expected ingest-pinning behavior.

**Known gaps confirmed (fixes in progress, not yet landed):**

- `PATCH /cluster/nodes/:id {status:'draining'}` is **registry-only** — LiveKit's own allocator
  ignores it, so a new room can still land on a node marked `draining`. Same gap as the 2-node
  test; reproduced here at 5-node scale.
- A **heartbeat bug un-drained nodes** — a node manually set to `draining` flipped back to
  `active` on its next heartbeat write, because the heartbeat handler didn't preserve an
  operator-set `draining` status. Both this and the drain-not-wired-to-the-allocator gap are
  being fixed; track their resolution before relying on `draining` for real maintenance windows.

**Per-size certification** (this is the new information this PoC adds over the 2-node test —
actual collapse points per instance size, not just "it works"):

| Size | Reliable concurrent RTMP ingest | Collapse point | Room-composite egress (HLS/recording)? |
|---|---|---|---|
| `t3.small` (2vCPU/2GB) | ~5–6 sessions | 12 sessions (loadavg 35) | No — below the 4-vCPU egress floor |
| `t3.medium`, `t3.large`, `c5.large` (2vCPU) | not pushed to collapse this run | — | No — all edges here are 2 vCPU |
| `c5.xlarge` (4vCPU/8GB, origin) | not the bottleneck in this run | — | **Yes — exactly 1 concurrent** composite (~1.5 GB RSS, 3 of 4 vCPUs) |

- **Room-composite egress (HLS-live and Chrome-based recording) needs ≥4 vCPU** — LiveKit
  egress hard-refuses with `not enough cpu for some egress types, minimumCpu: 4` below that
  (the same `minimumCpu: 4` egress floor the installer clamps `EGRESS_CPUS` to). In this fleet, only
  the `c5.xlarge` origin qualifies; **none of the 2-vCPU edges can serve composite HLS or
  recording**, regardless of RAM. Track/track-composite (ffmpeg, no Chrome) does not carry this floor and is the right default for
  small edges.
- **Pure room-serving (WebRTC fan-out, no composite) is cheap everywhere**: LiveKit itself sat
  at ~5% CPU serving 10 viewers — the vCPU floor above is specifically an egress/Chrome
  constraint, not a general SFU constraint.

---

## PoC B — GPU transcode on `g4dn.xlarge` / NVIDIA T4 (~$0.19, 45 min)

**Instance:** `g4dn.xlarge` (4 vCPU, 16 GB RAM, 1× NVIDIA T4, 16 GB VRAM), **spot**,
$0.234/hr observed.

```bash
aws ec2 run-instances --region "$AWS_REGION" \
  --image-id "$AMI_ID" --instance-type g4dn.xlarge \
  --key-name "$TAG" --security-group-ids "$SG_ID" --subnet-id "$SUBNET_ID" \
  --associate-public-ip-address \
  --instance-market-options '{"MarketType":"spot","SpotOptions":{"SpotInstanceType":"one-time","MaxPrice":"0.25"}}' \
  --block-device-mappings '[{"DeviceName":"/dev/sda1","Ebs":{"VolumeSize":50,"VolumeType":"gp3","DeleteOnTermination":true}}]' \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Project,Value=$TAG},{Key=Name,Value=gpu-t4}]" \
  --count 1 --query 'Instances[0].InstanceId' --output text
```

### GPU setup

```bash
# NVIDIA driver — stock Ubuntu 24.04 repo has 580
sudo apt-get update && sudo apt-get install -y nvidia-driver-580
sudo reboot   # required before nvidia-smi/nvenc work

# Verify: nvidia-smi shows the T4; stock Ubuntu ffmpeg already has h264_nvenc/hevc_nvenc/av1_nvenc
ffmpeg -hide_banner -encoders 2>/dev/null | grep nvenc

# nvidia-container-toolkit — required for `gpus: all` in docker-compose.yml to reach containers
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
  | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
  | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
  | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
sudo apt-get update && sudo apt-get install -y nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker && sudo systemctl restart docker
```

Install StreamHub (`--non-interactive --no-tls`, same as PoC C below), then uncomment
`gpus: all` on the `core` service in `docker-compose.yml` (already a documented override as of
today — see the `gpus: all` comment block in the repo's `docker-compose.yml`) and
`docker compose up -d core`. Confirm with `GET /api/v1/system/gpu`
([`transcoding-gpu.md`](../features/transcoding-gpu.md)) — returned `available:true,
type:"nvidia"` with the T4 listed.

### Results

**NVENC transcode ladder (1080p → 720p), single job:**

| Encoder | Speed |
|---|---|
| `libx264` (software) | 2.12x realtime |
| `h264_nvenc` (T4) | **4.6x realtime** |

**10 simultaneous NVENC jobs (1080p → 720p):** each sustained **≥1.67x realtime**, at only
**42% GPU utilization** — the ceiling in this run was the **4 vCPUs doing software decode**
(the T4's own decoder, NVDEC, wasn't in the pipeline yet), not the GPU. Extrapolated: a full
`-hwaccel cuda -hwaccel_output_format cuda` pipeline (decode + encode both on-GPU, no CPU
round-trip) would push meaningfully past 10 concurrent jobs — roughly **~16** by the observed
GPU-utilization headroom, not independently re-measured this run.

**CV inference, CUDA vs CPU** (`onnxruntime`, `CUDAExecutionProvider` verified active, with
confirmed graceful fallback to CPU when unavailable):

| Model | CUDA (T4) | CPU (same instance) | Speedup |
|---|---|---|---|
| deface / CenterFace @ 640×360 | 12.0 ms/frame | 52.1 ms/frame | ~4.3x (~10x on raw ONNX op time) |
| YOLOv8n | 8.9 ms/frame | 59.4 ms/frame | ~6.7x |

**App-level GPU detection** (`GET /api/v1/system/gpu`) confirmed end-to-end through Docker with
`gpus: all` + `nvidia-container-toolkit` — this is now a documented, ready-to-uncomment override
in `docker-compose.yml`, and `ffmpeg` ships in the core image so NVENC is usable without a
custom build. See [`transcoding-gpu.md`](../features/transcoding-gpu.md) for how this feeds the "offload
transcode/egress to a GPU node" roadmap item.

---

## PoC C — S3 recording round-trip (~$0.06, 22 min)

**Instance:** `c5.xlarge` standalone (not joined to a cluster), `--no-tls`.

```bash
curl -fsSL https://www.streamhub.studio/install.sh | sudo bash -s -- \
  --non-interactive --no-tls --domain <instance-public-ip>
```

### Scoped S3 setup — never use account root keys

```bash
BUCKET="streamhub-poc-$(date +%s)"
aws s3 mb "s3://$BUCKET" --region "$AWS_REGION"

cat > /tmp/streamhub-poc-s3-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject", "s3:ListBucket"],
    "Resource": ["arn:aws:s3:::$BUCKET", "arn:aws:s3:::$BUCKET/*"]
  }]
}
EOF

aws iam create-user --user-name streamhub-poc-s3 --tags Key=Project,Value=$TAG
aws iam put-user-policy --user-name streamhub-poc-s3 \
  --policy-name streamhub-poc-bucket-only \
  --policy-document file:///tmp/streamhub-poc-s3-policy.json
aws iam create-access-key --user-name streamhub-poc-s3   # capture AccessKeyId/SecretAccessKey once
```

The IAM user's inline policy is scoped to **exactly this one bucket** — no wildcard resource,
no other S3 access, no other AWS permission at all.

### Recording round-trip

```bash
# 1. configure the app's S3 target (key/secret never echoed back — see GET /s3)
curl -s -X PUT "$BASE/apps/live/s3" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"provider\":\"aws\",\"bucket\":\"$BUCKET\",\"region\":\"$AWS_REGION\",\"endpoint\":\"\",\"key\":\"$AKID\",\"secret\":\"$SECRET\"}"

# 2. push an RTMP test stream
ffmpeg -re -i sample.mp4 -c copy -f flv "rtmp://<instance-public-ip>:1935/live/<streamKey>"

# 3. start recording, then stop it
curl -s -X POST "$BASE/apps/live/recording/start" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"roomName":"poc-room"}'
curl -s -X POST "$BASE/apps/live/recording/<egressId>/stop" -H "Authorization: Bearer $TOKEN"

# 4. poll the VOD until status == "ready"
curl -s "$BASE/apps/live/vods/<vodId>" -H "Authorization: Bearer $TOKEN"

# 5. confirm the object landed in the bucket, and the presigned URL serves a valid MP4
aws s3 ls "s3://$BUCKET" --recursive
curl -sI "<presignedUrl from the vod response>"   # 200
```

### Results

VOD reached `ready`, the object was present in the bucket, the presigned URL returned `200`,
and the downloaded file was a valid MP4 (H.264 + AAC). `GET /apps/live/s3` was checked
throughout and **never echoed the key/secret** (masked, as designed).

**Gotcha found and fixed in core during this PoC:** setting `provider: "aws"` **without** an
explicit `endpoint` used to silently keep whatever endpoint was already in `config.yaml` from
scaffolding (typically the Wasabi endpoint), so an "aws" config could end up pointed at Wasabi's
host — fixed to auto-clear the endpoint when the provider is `aws` and none is given.
Fix: `fix(s3): provider 'aws' without explicit endpoint clears scaffold Wasabi endpoint`
(`streamhub-core`, commit `58de693`). This PoC is the reproduction + verification for that fix.

---

## Teardown & audit

Run immediately after each PoC's results are captured — do not let PoC resources outlive the
test.

```bash
# Instances (root volumes have DeleteOnTermination:true — no separate EBS cleanup)
aws ec2 terminate-instances --region "$AWS_REGION" --instance-ids <id...>
aws ec2 wait instance-terminated --region "$AWS_REGION" --instance-ids <id...>

# Any open spot request (PoC B)
aws ec2 cancel-spot-instance-requests --region "$AWS_REGION" \
  --spot-instance-request-ids <sir-id...>

# Security group (only after every ENI referencing it is gone, i.e. after instances terminate)
aws ec2 delete-security-group --region "$AWS_REGION" --group-id "$SG_ID"

# Key pair (AWS side + local private key file)
aws ec2 delete-key-pair --region "$AWS_REGION" --key-name "$TAG"
rm -f "$TAG.pem"

# S3 (PoC C) — empty before delete
aws s3 rm "s3://$BUCKET" --recursive
aws s3 rb "s3://$BUCKET"

# IAM (PoC C) — access key, then inline policy, then the user
aws iam delete-access-key --user-name streamhub-poc-s3 --access-key-id "$AKID"
aws iam delete-user-policy --user-name streamhub-poc-s3 --policy-name streamhub-poc-bucket-only
aws iam delete-user --user-name streamhub-poc-s3
```

**Final audit — every query below must return empty/`[]`:**

```bash
aws ec2 describe-instances --region "$AWS_REGION" \
  --filters "Name=tag:Project,Values=$TAG" "Name=instance-state-name,Values=pending,running,stopping,stopped" \
  --query 'Reservations[].Instances[].InstanceId'

aws ec2 describe-security-groups --region "$AWS_REGION" \
  --filters "Name=tag:Project,Values=$TAG" --query 'SecurityGroups[].GroupId'

aws ec2 describe-key-pairs --region "$AWS_REGION" \
  --filters "Name=tag:Project,Values=$TAG" --query 'KeyPairs[].KeyName'

aws ec2 describe-spot-instance-requests --region "$AWS_REGION" \
  --filters "Name=tag:Project,Values=$TAG" \
  --query 'SpotInstanceRequests[?State!=`cancelled` && State!=`closed`].SpotInstanceRequestId'

aws s3api list-buckets --query "Buckets[?starts_with(Name,'streamhub-poc')].Name"

aws iam list-users --query "Users[?starts_with(UserName,'streamhub-poc')].UserName"
```

This is the same audit run at the end of all three PoCs; it returned empty on every query,
confirming zero residual billable resources.

---

## Cost summary

| PoC | Instance(s) | Pricing model | Wall time | Cost |
|---|---|---|---|---|
| A — 5-node cluster | 1× `c5.xlarge` + `t3.small` + `t3.medium` + `t3.large` + `c5.large` | on-demand | 50 min | ~$0.33 |
| B — GPU transcode/CV | 1× `g4dn.xlarge` | spot ($0.234/hr observed) | 45 min | ~$0.19 |
| C — S3 recording loop | 1× `c5.xlarge` | on-demand | 22 min | ~$0.06 |
| **Total** | | | **~117 min** | **~$0.58** of a $50 budget |

## Findings / fixes cross-reference

| Finding | Where it's tracked |
|---|---|
| Ingest is pinned to the local node — no ingest-session failover | this doc (PoC A) |
| `draining` is registry-only, not wired to LiveKit's allocator | this doc (PoC A) |
| Heartbeat write clobbers an operator-set `draining` status | this doc (PoC A) — fix in progress |
| Room-composite egress needs ≥4 vCPU (`minimumCpu: 4`) | this doc (PoC A) |
| `provider:"aws"` without `endpoint` kept a stale scaffold endpoint | **fixed**, `streamhub-core` commit `58de693` — reproduced/verified in this doc (PoC C) |
| GPU passthrough (`gpus: all`) + `nvidia-container-toolkit` reaches `/api/v1/system/gpu` and NVENC | **shipped** (`docker-compose.yml` override + `ffmpeg` in the core image, commit `3ab4ced`) — verified in this doc (PoC B) |

## Related docs

- [`INSTALL-NODE.md`](./INSTALL-NODE.md) — the installer flags used throughout (`--non-interactive`, `--no-tls`, `--cluster-redis-bind`, `--join`)
- [`../features/transcoding-gpu.md`](../features/transcoding-gpu.md) — GPU detection API and hwaccel config exercised in PoC B
- [`../architecture/cluster.md`](../architecture/cluster.md) — target cluster design; this PoC is empirical evidence for the origin/edge topology described there
