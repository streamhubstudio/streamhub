# Build a StreamHub cluster on AWS

Step-by-step guide to stand up a StreamHub cluster on AWS exactly like our validated
proof-of-concept. It reproduces [AWS-POC2-REPORT.md](./AWS-POC2-REPORT.md) and
[AWS-POC.md](./AWS-POC.md) (5 nodes on EC2, GPU transcode, S3 recording) and folds in the
day-0/day-1 installer behaviour from [INSTALL-NODE.md](./INSTALL-NODE.md) and the mechanics
proven on bare metal in [CLUSTER-2NODE-TEST.md](./CLUSTER-2NODE-TEST.md).

Written for an operator who has **never used AWS beyond the console**. Every step is given as a
console click-path first, with the exact AWS CLI command from the PoC underneath for anyone who
prefers to script it. Nothing here needs Elastic IPs, load balancers, or a custom VPC.

> **What a "cluster" gives you and what it does not.** One **origin** runs the whole control
> plane (the `core` API, the dashboard, Redis, LiveKit, ingress, egress). **Edges** add media
> capacity: each edge runs only `livekit + ingress + egress` and coordinates with the origin
> through the origin's shared Redis. LiveKit itself places each room on one node (session
> affinity); StreamHub has **no capacity/region-aware scheduler yet** and **cross-node recording
> is a known open gap** — read [§8 Known limitations](#8-known-limitations) *before* you rely on
> this for recording or a maintenance-window drain.

---

## 1. Prerequisites

- An AWS account you can log into (the console is enough; the CLI is optional).
- A **region** — pick one close to your viewers and stay in it for every step. The PoC used
  `us-east-1`.
- Ability to SSH: you will download one key pair (`.pem`) and `chmod 400` it.
- **Ubuntu Server 24.04/26.04 LTS or Debian 12 (bookworm) / 13 (trixie), x86_64 only** — the
  installer validates `/etc/os-release` + `uname -m` and aborts on anything else, e.g. ARM/Graviton
  or Amazon Linux (`STREAMHUB_SKIP_OS_CHECK=1` overrides at your own risk). AWS publishes official
  Debian AMIs (owner `136693071363`); the same one-liner install works there unchanged.
- A cluster token (`clt_…`) — you don't create this; the origin install prints it and the edges
  consume it.
- Optional but recommended: a DNS name for the origin (an `A` record → the origin's public IP,
  **DNS-only, no CDN proxy** — WebRTC media is UDP). Edges never terminate TLS, so they need no
  DNS.

**Cost discipline (from the PoC).** Tag every object `Project=streamhub-cluster` at creation,
never use Elastic IPs (auto-assigned public IPs die with the instance), keep root volumes
`DeleteOnTermination=true`, and time-box the exercise. The round-2 PoC ran **6 instances for
~1–2 h for ≈ USD 1**.

---

## 2. Security group — the one thing you must get right

A security group (SG) is AWS's per-instance firewall. Create **one** SG and attach it to every
node in the cluster. It needs two kinds of rules:

1. **Public media/ingest ports** — open to the internet so browsers and encoders can reach any
   node directly (WebRTC/RTMP/WHIP media goes straight to the owning node's public IP, it is not
   proxied).
2. **One self-referencing rule for Redis** — so nodes reach each other's `6379` over **private**
   IPs, and Redis is **never** exposed to the internet.

### Port table (exact)

| Port | Proto | Purpose | Exposure |
|---|---|---|---|
| 22 | tcp | SSH | your IP only (tighten from `0.0.0.0/0` for anything longer-lived) |
| 80 | tcp | HTTP (nginx/Caddy; ACME challenge + `/rtc` WebSocket) | public |
| 443 | tcp | HTTPS (nginx+certbot or Caddy auto-TLS) | public |
| 1935 | tcp | RTMP ingest | public |
| 7880 | tcp | LiveKit WebSocket signaling (`/rtc`, proxied on 80/443) | public |
| 7881 | tcp | LiveKit ICE-TCP fallback (viewers on UDP-blocked networks) | public |
| 8080 | tcp | WHIP ingest (WebRTC push) | public |
| 7882 | udp | LiveKit WebRTC **media** | public |
| 6379 | tcp | Redis — cluster coordination | **private only — self-referencing SG, never `0.0.0.0/0`** |
| 3020 | tcp | core API | **not opened** — core binds `127.0.0.1:3020`; reach it via the proxy on 80/443 |

This is the same set `install.sh` preflights on every node (see
[INSTALL-NODE.md](./INSTALL-NODE.md)). Port `3020` is deliberately absent: the core listens on
loopback only, so there is nothing to open — the reverse proxy on `:80`/`:443` is the public
door.

### Console steps

1. **EC2 → Network & Security → Security Groups → Create security group.**
2. Name it `streamhub-cluster`, description "StreamHub cluster", VPC = your **default VPC**.
3. **Inbound rules → Add rule** for each public row above:
   - SSH `22` → Source **My IP**.
   - Custom TCP `80`, `443`, `1935`, `7880`, `7881`, `8080` → Source `Anywhere-IPv4`
     (`0.0.0.0/0`).
   - Custom UDP `7882` → Source `Anywhere-IPv4`.
4. **The self-referencing Redis rule (the free-private-IP trick):** Add one more rule —
   Custom TCP, port `6379`, and for **Source** start typing the security group's **own name/ID**
   (`streamhub-cluster` / `sg-…`) and select it. Source = the SG itself.
   - This means "any instance that is a member of this SG may reach `6379` on any other member,
     over its private IP." No public exposure, and **intra-VPC traffic between instances in the
     same Availability Zone is free** — so all your Redis/LiveKit coordination costs nothing and
     never leaves Amazon's network.
   - **Keep every node in the same subnet / Availability Zone** so their private IPs are directly
     routable and same-AZ traffic stays free.
5. Leave outbound rules at the default (allow all). **Create security group.**

### CLI equivalent (from the PoC)

```bash
export AWS_REGION=us-east-1
export TAG=streamhub-cluster

VPC_ID=$(aws ec2 describe-vpcs --region "$AWS_REGION" \
  --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)

SG_ID=$(aws ec2 create-security-group --region "$AWS_REGION" \
  --group-name "$TAG" --description "streamhub cluster" --vpc-id "$VPC_ID" \
  --tag-specifications "ResourceType=security-group,Tags=[{Key=Project,Value=$TAG}]" \
  --query GroupId --output text)

# public ingest / signaling / media
for rule in "tcp 22" "tcp 80" "tcp 443" "tcp 1935" "tcp 7880" "tcp 7881" "tcp 8080"; do
  set -- $rule
  aws ec2 authorize-security-group-ingress --region "$AWS_REGION" --group-id "$SG_ID" \
    --protocol "$1" --port "$2" --cidr 0.0.0.0/0
done
aws ec2 authorize-security-group-ingress --region "$AWS_REGION" --group-id "$SG_ID" \
  --protocol udp --port 7882 --cidr 0.0.0.0/0

# THE self-reference: any node in this SG can reach redis 6379 on any other node in it.
aws ec2 authorize-security-group-ingress --region "$AWS_REGION" --group-id "$SG_ID" \
  --protocol tcp --port 6379 --source-group "$SG_ID"
```

> **ufw note.** StreamHub runs LiveKit with host networking, and the installer opens the same
> ports in `ufw` if it is active. With host networking `ufw` **does** filter the containers (no
> Docker-chain bypass), so the SG and `ufw` reinforce each other. Even so, keep `6379` on a
> private interface + password (the installer does both when you use `--cluster-redis-bind`) and
> prefer a private network/VPN for anything production.

---

## 3. Key pair

**Console:** EC2 → Network & Security → Key Pairs → **Create key pair**, name `streamhub-cluster`,
type `ED25519`, format `.pem`. The browser downloads the private key once — save it and

```bash
chmod 400 streamhub-cluster.pem
```

**CLI:**

```bash
aws ec2 create-key-pair --region "$AWS_REGION" --key-name "$TAG" \
  --tag-specifications "ResourceType=key-pair,Tags=[{Key=Project,Value=$TAG}]" \
  --query 'KeyMaterial' --output text > "$TAG.pem"
chmod 400 "$TAG.pem"
```

---

## 4. Launch the origin

The origin runs the full control plane and must be able to serve **room-composite egress**
(HLS-live and Chrome-based recording), which LiveKit **hard-refuses below 4 vCPUs**
(`not enough cpu for some egress types, minimumCpu: 4`). So the origin needs **≥ 4 vCPU**.

### Instance sizing guidance

| Role | Recommended | Why |
|---|---|---|
| **origin** | `c5.xlarge` (4 vCPU / 8 GB) | Runs core + Redis + nginx + LiveKit + ingress + egress. 4 vCPU is the floor for **one** concurrent composite recording/HLS (~1.5 GB RSS, ~3 of 4 vCPUs). The PoC origin under transcode load sat at ~1.3 GB / 7.6 GB RAM — the stack is lean; **egress (headless Chrome) is the real RAM lever** for concurrent recordings. |
| **edge (media/SFU)** | `c5.large` / `t3.medium` (2 vCPU) | Plenty for WebRTC fan-out and RTMP/WHIP ingest. **Cannot** do composite HLS or recording (below the 4-vCPU egress floor) — fine, since the origin owns recording. `t3.small` (2 vCPU/2 GB) took ~5–6 reliable RTMP ingests and collapsed around 12. |
| **GPU transcode node** (optional) | `g4dn.xlarge` **spot** (NVIDIA T4) | NVENC 1080p→720p ~4.6–6.9× realtime; ~$0.22/h spot. See [AWS-POC.md §PoC B](./AWS-POC.md) and [../features/transcoding-gpu.md](../features/transcoding-gpu.md). |

Rule of thumb: **one 4-vCPU origin + as many 2-vCPU edges as you need for viewer/ingest fan-out.**
Pure room-serving (WebRTC fan-out, no composite) is cheap everywhere — LiveKit sat at ~5% CPU
serving 10 viewers.

### Console steps (origin)

1. **EC2 → Instances → Launch instances.**
2. Name `streamhub-origin`. **AMI:** search *Ubuntu*, pick **Ubuntu Server 24.04 LTS (64-bit
   x86)** — not ARM. (An official **Debian 12/13 (64-bit x86)** AMI works too; the SSH login
   user is then `admin`, not `ubuntu`.)
3. **Instance type:** `c5.xlarge`.
4. **Key pair:** `streamhub-cluster`.
5. **Network settings → Edit → Select existing security group →** `streamhub-cluster`. Confirm
   **Auto-assign public IP = Enable**.
6. **Storage:** 30 GB `gp3`, and make sure **Delete on termination** is on (default).
7. **Launch instance.** When it is running, note its **Public IPv4** and **Private IPv4**
   addresses (Instances → select → Details).

### CLI equivalent

```bash
# Resolve the current Ubuntu 24.04 amd64 AMI live (never hardcode an AMI id):
AMI_ID=$(aws ssm get-parameters --region "$AWS_REGION" \
  --names /aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id \
  --query 'Parameters[0].Value' --output text)
SUBNET_ID=$(aws ec2 describe-subnets --region "$AWS_REGION" \
  --filters "Name=vpc-id,Values=$VPC_ID" --query 'Subnets[0].SubnetId' --output text)

aws ec2 run-instances --region "$AWS_REGION" \
  --image-id "$AMI_ID" --instance-type c5.xlarge \
  --key-name "$TAG" --security-group-ids "$SG_ID" --subnet-id "$SUBNET_ID" \
  --associate-public-ip-address \
  --block-device-mappings '[{"DeviceName":"/dev/sda1","Ebs":{"VolumeSize":30,"VolumeType":"gp3","DeleteOnTermination":true}}]' \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Project,Value=$TAG},{Key=Name,Value=streamhub-origin}]" \
  --count 1 --query 'Instances[0].InstanceId' --output text
```

---

## 5. Install StreamHub on the origin

SSH in and run the **published landing one-liner** — the exact command from the
[install.sh header](../../install.sh) / [INSTALL-NODE.md](./INSTALL-NODE.md). Never build from
source by hand.

```bash
ssh -i streamhub-cluster.pem ubuntu@<origin-public-ip>
```

Then, on the origin, pick one of the two forms.

**With a DNS name + TLS (production-shaped):**

```bash
curl -fsSL https://www.streamhub.studio/install.sh | sudo bash -s -- \
  --non-interactive \
  --domain media.example.com --email admin@example.com \
  --admin-pass 'S3cret!' \
  --cluster-redis-bind <origin-private-ip>
```

**Bare IP, no TLS (fast PoC, exactly what the AWS PoC used):**

```bash
curl -fsSL https://www.streamhub.studio/install.sh | sudo bash -s -- \
  --non-interactive --no-tls \
  --domain <origin-public-ip> \
  --cluster-redis-bind <origin-private-ip>
```

(`--no-tls` is auto-selected when `--domain` is a bare IP literal — Let's Encrypt can't issue a
cert for an IP.) Interactive install (`… | sudo bash`, no flags) also works and prompts for
domain/email.

The installer provisions Docker, the repo in `/opt/streamhub`, a `.env` with strong random
secrets, the whole stack (`redis livekit ingress egress core`), nginx+certbot (or `--proxy caddy`
for auto-TLS), seeds the `sk_` API token, installs a 60 s **heartbeat timer**, and self-registers
the origin in its own `nodes` table. The final summary prints the **dashboard URL + admin
credentials, the `sk_` API token, the RTMP/WHIP/HLS endpoints, the cluster token (`clt_…`), and a
ready-made edge join one-liner.** Copy the cluster token — the edges need it.

### `--cluster-redis-bind <origin-private-ip>` — why this flag is mandatory for a cluster

**Without it, every edge crash-loops and no media ever comes up.** A default origin binds Redis to
`127.0.0.1:6379` only. Edges are then handed `redis://<origin>:6379` and their
`livekit`/`ingress`/`egress` cannot connect → **crash-loop** (`connection refused`). The control
plane (registry + heartbeat) still works, which is why a broken cluster can *look* joined while no
room ever meshes. This was AWS-POC2 **finding #2** and is now guarded on both ends.

`--cluster-redis-bind <origin-private-ip>` makes Redis **also** listen on that private address with
a **generated password**, and the join hands each edge `redis://:<pass>@<private-ip>:6379`. Use the
origin's **private** IP (the self-referencing SG in §2 already allows `6379` between members) —
never a public one. If you install the origin without this flag, the summary now prints a prominent
warning telling you edges can't join until Redis is bound, with the exact remedy:

```bash
# remedy on an already-running origin (no reinstall):
# append to /opt/streamhub/.env, then recreate redis
REDIS_BIND=127.0.0.1 <origin-private-ip>
STREAMHUB_CLUSTER_REDIS_URL=redis://:<generated-pass>@<origin-private-ip>:6379
# then:
cd /opt/streamhub && docker compose up -d --force-recreate redis
```

With a self-referencing SG the private `6379` is already reachable between members. If you instead
run `ufw` on the box, allow only each edge explicitly:
`ufw allow from <edge-private-ip> to any port 6379 proto tcp`. **Never expose `6379` to
`0.0.0.0/0`.**

---

## 6. Launch and join the edges

Launch each edge exactly like the origin (§4) but with a **2-vCPU** type (`c5.large` or
`t3.medium`) and the **same** security group and key pair. Edges need **no DNS and no TLS**.

SSH into each edge and run the join form of the one-liner:

```bash
ssh -i streamhub-cluster.pem ubuntu@<edge-public-ip>

curl -fsSL https://www.streamhub.studio/install.sh | sudo bash -s -- \
  --join \
  --master-token <clt_...> \
  --master-ip <origin-private-ip> \
  --master-url http://<origin-private-ip> \
  --node-name edge-1 --region us-east-1
```

### The two things that trip people up

- **Point the join at the proxy, NOT `:3020`.** The core binds `127.0.0.1:3020`, so
  `http://<ip>:3020` can never connect from another host. The join now defaults to the origin's
  reverse proxy on **`:80`** (`http://<origin-ip>`) and auto-falls-back to `:3020` on a connect
  failure. Pass `--master-url http://<origin-private-ip>` explicitly (or, for a TLS origin,
  `--master-url https://media.example.com`). This was AWS-POC2 **finding #1**.
  *(Legacy flag names `--cluster-token / --origin-ip / --origin-url` are still accepted.)*
- **`--master-ip` is the origin's PRIVATE IP.** Edges share the origin's Redis over the private
  interface allowed by the self-referencing SG. Before it starts any media service, the join runs
  a **Redis TCP preflight**; if Redis isn't reachable it **aborts with the origin-side remedy**
  instead of crash-looping. (Override only for debugging: `STREAMHUB_SKIP_REDIS_PREFLIGHT=1`.)

What join does: `POST /api/v1/cluster/join` on the origin with header `X-Cluster-Token` →
registers the node and receives the **cluster-wide LiveKit keys** (identical on every node) + the
Redis URL (with password) + the origin's webhook URL. It writes the edge `.env`, runs the Redis
preflight, then starts **only** `livekit ingress egress` (`--no-deps` — no local Redis, no core).
Joins are **idempotent**: re-running an already-joined edge re-registers (same `nodeId`, picks up
rotated keys). The edge also gets the 60 s heartbeat timer so it stays fresh in the registry.

Repeat per edge with a distinct `--node-name`.

---

## 7. Verify the cluster

1. **Nodes API** (Bearer the origin's `sk_` token, from the install summary):

   ```bash
   curl -s http://<origin-public-ip>/api/v1/cluster/nodes \
     -H "Authorization: Bearer sk_..." | jq
   ```

   Every node — origin + each edge — should appear with `status: "active"`, `stale: false`, a
   recent `last_seen_at`, and its `stats` (cpu/ram/cores).

2. **Heartbeats.** Wait ~90 s and re-query: `last_seen_at` should keep advancing on every node
   (the 60 s heartbeat timer). A node whose `last_seen_at` is older than 90 s flips to
   `stale: true` — that's your liveness signal. (In the PoC, stopping an edge's heartbeat flipped
   it to `stale` in ~90 s while the origin + other edges stayed fresh.)

3. **Dashboard.** Open `https://media.example.com` (or `http://<origin-public-ip>`), log in with
   the admin credentials from the summary, and confirm the nodes show up.

4. **Media mesh smoke test.** Push one RTMP stream per node and confirm rooms distribute across
   nodes and WebRTC playback works from any node:

   ```bash
   ffmpeg -re -i sample.mp4 -c copy -f flv rtmp://<edge-public-ip>:1935/<app>/<streamKey>
   ```

   The room may land on a **different** node than the one you ingested to (LiveKit's allocator
   places it on the least-loaded node via shared Redis; the ingress publishes cross-node over UDP
   7882). WebRTC media always plays from the owning node's public IP. HLS/recording is where the
   known gap bites — see below.

---

## 8. Known limitations

These are reproduced and tracked; read them before you depend on the cluster. Full backlog in
[STABILIZATION.md](./STABILIZATION.md).

| Limitation | Behaviour | Reference |
|---|---|---|
| **Cross-node egress placement (recording/HLS)** | Any egress worker in the cluster can claim a `StartEgress` and writes the file to **its own** disk, while the origin core looks on **its** disk → the VOD/HLS is missing (silent failure). The `stopEgress` RPC can also route to the wrong node → twirp timeout, VOD never finalizes. With 2 nodes, ~50% of recordings land on the wrong disk. **Mitigation:** record only when the room is on the origin, or use egress-direct-to-S3 / shared storage / room-pinned egress (not yet shipped). | AWS-POC2 finding #3; [CLUSTER-2NODE-TEST.md](./CLUSTER-2NODE-TEST.md) §"Gap de grabación cross-node"; [STABILIZATION.md](./STABILIZATION.md) |
| **`draining` is registry-only** | `PATCH /cluster/nodes/:id {status:'draining'}` marks the node in StreamHub's registry but is **not wired to LiveKit's allocator** — a new room can still land on a draining node. | [AWS-POC.md](./AWS-POC.md) PoC A; [CLUSTER-2NODE-TEST.md](./CLUSTER-2NODE-TEST.md) |
| **No ingest-session failover** | If a node dies, its live **rooms re-allocate** to a live node (~60–120 s) and playback resumes, but **publishers that ingested through that node's ingress die and do not fail over** — ingest is pinned to the node the RTMP/WHIP session opened on. Put a DNS/LB layer in front of the fleet so publishers reconnect against a live node. | [AWS-POC.md](./AWS-POC.md) PoC A; [CLUSTER-2NODE-TEST.md](./CLUSTER-2NODE-TEST.md) |
| **No capacity/region-aware scheduler** | Placement is 100% LiveKit's own load-based allocator; there is no StreamHub-side steering by region or capacity yet. | [CLUSTER-2NODE-TEST.md](./CLUSTER-2NODE-TEST.md) |
| **Composite egress needs ≥ 4 vCPU** | HLS-live and Chrome-based recording refuse below 4 vCPU. 2-vCPU edges serve WebRTC/ingest fine but cannot record. | [AWS-POC.md](./AWS-POC.md), [CAPACITY-G2.md](./CAPACITY-G2.md) |

---

## 9. Teardown checklist (full)

Terminating instances reclaims compute **and** storage (root volumes are
`DeleteOnTermination=true`), so there is no separate EBS cleanup. Tear down by **tag**, then run
the audit so nothing keeps billing.

### Console

1. **EC2 → Instances** → select every `streamhub-*` instance → **Instance state → Terminate**.
   Wait until state is `Terminated`.
2. **EC2 → Spot Requests** → cancel any open request (only if you launched the optional GPU node
   as spot).
3. **EC2 → Security Groups** → delete `streamhub-cluster` (only possible once all instances are
   fully terminated and their network interfaces release — retry if it complains).
4. **EC2 → Key Pairs** → delete `streamhub-cluster`, and `rm` the local `.pem`.
5. If you configured S3 recording: **S3** → empty then delete the bucket; **IAM** → delete the
   scoped user + its access key + inline policy.
6. If you created a DNS record, delete it (a Route 53 hosted zone bills ~$0.50/mo if you keep it).

### CLI + audit (must all return empty)

```bash
aws ec2 terminate-instances --region "$AWS_REGION" --instance-ids <id...>
aws ec2 wait instance-terminated --region "$AWS_REGION" --instance-ids <id...>
aws ec2 cancel-spot-instance-requests --region "$AWS_REGION" --spot-instance-request-ids <sir...>  # if any
aws ec2 delete-security-group --region "$AWS_REGION" --group-id "$SG_ID"
aws ec2 delete-key-pair --region "$AWS_REGION" --key-name "$TAG" && rm -f "$TAG.pem"
# S3 + IAM only if you set up recording (see AWS-POC.md PoC C for the exact commands)

# Audit — every query must return [] / empty:
aws ec2 describe-instances --region "$AWS_REGION" \
  --filters "Name=tag:Project,Values=$TAG" \
            "Name=instance-state-name,Values=pending,running,stopping,stopped" \
  --query 'Reservations[].Instances[].InstanceId'
aws ec2 describe-security-groups --region "$AWS_REGION" \
  --filters "Name=tag:Project,Values=$TAG" --query 'SecurityGroups[].GroupId'
aws ec2 describe-key-pairs --region "$AWS_REGION" \
  --filters "Name=tag:Project,Values=$TAG" --query 'KeyPairs[].KeyName'
```

Full teardown + audit (including S3/IAM and spot) is scripted end-to-end in
[AWS-POC.md §Teardown & audit](./AWS-POC.md#teardown--audit).

---

## Related docs

- [INSTALL-NODE.md](./INSTALL-NODE.md) — day-0 origin install + day-1 `--join` reference, all flags
- [AWS-POC2-REPORT.md](./AWS-POC2-REPORT.md) — the round-2 PoC this guide reproduces (findings #1–#4)
- [AWS-POC.md](./AWS-POC.md) — round-1: 5-node cluster, GPU/NVENC numbers, S3 recording round-trip, per-size certification
- [CLUSTER-2NODE-TEST.md](./CLUSTER-2NODE-TEST.md) — bare-metal 2-node control-plane + media-mesh validation
- [STABILIZATION.md](./STABILIZATION.md) — living backlog incl. the cross-node egress gap
- [../architecture/cluster.md](../architecture/cluster.md) — target cluster design (origin/edge, heartbeat, self-registration)
