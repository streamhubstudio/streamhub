# StreamHub Cluster — Reality, Security & Distribution Roadmap

> **Historical note:** `file:line` citations refer to the 2.x Node core (`streamhub-core/src/…`, tag `2.24.0`); in the Go core the same code lives in `streamhub-core-go/internal/{cluster,edge,plugins}`, and the BullMQ queues mentioned below are in-process queues (`internal/recording`) — Redis is LiveKit's only.

> Evidence-backed audit + design (2026-07-08). Grounded in the code at file:line via a
> 5-track parallel investigation. This is the reference for evolving the cluster from a
> **registry** into a **real distribution fabric**.

## 0. Executive summary

- **What the cluster delegates today: nothing.** The `modules/cluster` code is a **node
  registry** — `join` + `heartbeat` + `list/patch/remove`. It routes **zero** StreamHub
  workload (no ingest, egress, transcode, playback, or plugin work) to nodes.
- The only real cross-node distribution is **LiveKit's own** room mesh over **shared Redis**,
  which the installer wires up. StreamHub has **no scheduler/router of its own** yet.
- **The grid seam** (`worker.placement: 'local' | 'grid'` for offloading GPU plugin workers)
  is fully typed + unit-tested, but the **remote-dispatch step is a deliberate stub** that
  always falls back to a local spawn (TODO GRID-1..4).
- **Data & VOD processing is 100% on the master** (the `core` process — SQLite owner + BullMQ
  queues + `/hls` server — runs only on the origin). VOD transcode is even **software-only**
  (libx264/libvpx, no GPU) and serialized at concurrency 1.
- **Security has a CRITICAL hole**: `POST /cluster/join` vends the **LiveKit apiSecret** +
  **Redis password** to anyone holding the single static cluster token, by default over
  **plaintext HTTP**, with **no rate-limit and no auto-ban**.
- **The single unlock** for most distribution: stop using the shared local `DATA_DIR`
  bind-mount as the transport and **use S3 as the transport**. That one change fixes the
  orphaned-recording + cross-node-HLS-404 bugs and unlocks transcode/GPU offload.

---

## 1. What the cluster delegates today (registry-only)

Routes (`modules/cluster/cluster.controller.ts`, base `/api/v1/cluster`):

| Route | Auth | Does |
|---|---|---|
| `POST /cluster/join` | Public + `X-Cluster-Token` | Upsert node by name; **returns LiveKit apiKey/apiSecret/wsUrl + redisUrl + publicWsUrl** |
| `POST /cluster/heartbeat` | Public + `X-Cluster-Token` | Bump `last_seen`, store ≤4KB `stats` blob, promote to active |
| `GET /cluster/info` | Bearer | `enabled`, `nodesCount`, **the cluster token**, redis URL, join one-liner |
| `GET /cluster/nodes` | Bearer | List registry rows + derived `stale` (90s) |
| `PATCH /cluster/nodes/:id` | Bearer | Edit name/region/status (`active|draining|disabled`) |
| `DELETE /cluster/nodes/:id` | Bearer | Remove a row |

- `nodes` table (`shared/db/migrations.ts:149`): `id, name, url, region, status, created_at,
  last_seen_at, stats_json`. `stale` is derived, not stored.
- Origin self-registers a fixed `id='origin'` row at boot (`cluster.service.ts:352`).
- **No code ever calls `node.url`.** No router/scheduler module exists (it's "step 4, future"
  in `architecture/cluster.md:96`).
- `apps.node_id` column exists but is **written by migration only, never read** — dead scaffolding.
- **Doc drift**: CLAUDE.md / INSTALL-NODE.md say `/api/v1/nodes`; the real routes are
  `/api/v1/cluster/*`. Fix the docs.

**Known limitations (observed, `CLUSTER-2NODE-TEST.md`):** `draining` is administrative only
(LiveKit ignores it); cross-node egress **orphans ~50% of recordings** (each node writes to its
own disk); no ingest-session failover.

### The grid seam (`plugin.contract.ts:42-51`)
- `PluginGridService.listGridNodes()` / `matchGridNode()` / `selectNode()` — **real, pure,
  tested** (discovery + selection by gpu/vram/capabilities/region).
- `PluginGridService.dispatch()` — **STUB**: always `{dispatched:false,'TODO GRID-1'}` → the
  worker manager logs intent and **spawns locally**. No shipped plugin requests `grid` (only
  `_templates/`). Installer heartbeat advertises **no GPU block**, so `listGridNodes()` finds
  nothing even if wired.

---

## 2. Cluster security (has a public endpoint — here's the threat model)

**Positives to keep:** token compare is **constant-time** (SHA-256 + `timingSafeEqual`,
`cluster.controller.ts:193`); token entropy is strong (~190 bits CSPRNG); ≤4KB stats guard;
secrets kept out of logs.

**CRITICAL / HIGH issues:**

1. **[CRITICAL] `join` vends cross-tenant secrets.** One valid `X-Cluster-Token` → the
   **LiveKit apiSecret** (mint tokens for ANY room in ANY tenant, record, kick) + the **Redis
   password**. Default installer joins over **plaintext HTTP** → MITM captures all of it
   (`install.sh:727`, `cluster.service.ts:192-206`).
2. **[HIGH] No rate-limit / no auto-ban on the token check.** The `express-rate-limit` covers
   only login/magic paths; a bad cluster token throws directly and **never records an offense**,
   so the auto-ban never triggers. Brute-force bounded only by entropy.
3. **[HIGH] One shared, non-rotatable token**, no per-node scoping, reused forever as the
   heartbeat cred, and surfaced by `GET /cluster/info` + the install summary.
4. **[MEDIUM] Redis off-box + cleartext** when clustered (no TLS); operator can bind it publicly.
5. **[MEDIUM] Stats poisoning**: a token holder can heartbeat the fixed `origin` id or
   upsert-by-name to overwrite a node's url/stats (feeds grid selection).
6. **[LOW/LATENT] Unvalidated join `url`** → SSRF once GRID-1 dispatch POSTs to `<node.url>`.

**Hardening (prioritized):**
- **P0**: don't return the raw LiveKit apiSecret / Redis password in `join` (hand back a
  scoped, short-lived credential or per-node LiveKit key); **enforce TLS** for join/heartbeat
  (reject plaintext, check `X-Forwarded-Proto`); require Redis TLS when bound off-loopback.
- **P1**: per-node enrollment tokens + rotation/revocation; **rate-limit + `recordOffense`** on
  failed `assertClusterToken` so auto-ban covers it; turn the network-security module on by
  default (or document it's off).
- **P2**: bind heartbeat to node identity (reject `origin` writes from the network); validate
  the join `url` + SSRF guard before GRID-1.
- **P3**: mTLS / signed short-lived join ticket; redact token from install summary.

---

## 3. Data & VOD distribution (all master-only today)

- **SQLite is two-tier and origin-only**: global `data/streamhub.db` (tenants/users/tokens/
  nodes/apps-pointer) + per-app `apps/<app>/app.db` (streams/vods/variants/…). Local
  `better-sqlite3` handles, **no replication, no shared FS**. Core runs only on the origin.
- **VOD pipeline, every stage on the master:**
  - **Record** — egress writes MP4 to a **local** `apps/<app>/recordings/` path; in a mesh any
    node's egress can claim the job and writes to *its* disk → origin can't find it → `local
    recording file missing` → VOD `failed`.
  - **Upload→S3** — BullMQ `streamhub-recording-upload` (origin), **requires the local file**.
  - **Transcode** — BullMQ `streamhub-vod-transcode`, **concurrency 1**, **software-only**
    (`libx264`/`libvpx`, no nvenc/vaapi anywhere), requires local source.
  - **Transcribe** — whisper worker on the origin; but `resolveSource` **already tolerates a
    presigned S3 URL** (the least-coupled stage).
- **Bottlenecks:** (1) the **SQLite-on-master is single-writer** — an offloaded job's result is
  a row that only the origin can write (no ingest API for results exists); (2) **DATA_DIR is
  per-node**, not shared.
- **Shared state today:** LiveKit's Redis (room→node map + egress job claims); StreamHub BullMQ
  binds to the origin's **local** redis (not the cluster redis). S3 is durable but only after an
  origin-side upload. Reads already prefer S3 (`getDownload`/`probeVod`/transcription fall back
  to presigned URLs).
- **The unlock: make S3 the transport** (egress-direct-to-S3), then offload transcode/whisper to
  worker nodes bound to the shared redis — which still needs an **origin-side result-ingest API**
  because the per-app SQLite is single-writer.

---

## 4. Distribution roadmap (ranked by value ÷ effort)

**#0 (prerequisite) — Break the filesystem coupling: S3 as transport.** Egress writes direct to
S3 (LiveKit S3 output); rework the upload job to key off the S3 object, not a local path. Fixes
the orphaned-recording + cross-node-HLS-404 bugs. Unlocks #1, #2(multi-region), #4.

1. **VOD transcode → worker nodes** (HIGHEST value/effort). Decouple the `streamhub-vod-transcode`
   BullMQ worker from the core process; source from S3; nodes pointed at the shared redis pull
   jobs. Batch, latency-tolerant, zero media-plane risk.
2. **Edge/CDN for HLS** (VERY HIGH, cache variant). `/hls` playlist base is already
   reverse-proxy-aware — front it with a caching CDN/Caddy for near-zero-code bandwidth relief.
   Multi-region variant depends on #0.
3. **GPU offload of the Python workers via GRID-1..3** (flagship "BYO-GPU"). yolo/deface/
   transcription all spawn locally today (`placement:local`). yolo is cleanest (HLS-URL in, HTTP
   callback out — already network-capable). Missing: the remote dispatch agent
   (`<node.url>/api/v1/grid/workers`), remote lifecycle, origin-URL feedback wiring, and a `grid`
   GPU block in the heartbeat (nvidia-smi detect).
4. **Record-on-owning-node** (fixes the real bug) — via #0 (egress→S3) or pin egress to the
   origin. Note egress needs ≥4 CPUs.
5. **Cluster scheduler** (enabler) — a single `NodeScheduler` using heartbeat `cpu`/`memUsedRatio`
   + region + the `grid` block; add a least-loaded tiebreak to `matchGridNode` (today it ignores
   CPU load).
6. **Ingest distribution** — LiveKit ingress already runs per-node; the publisher URL is a single
   global `RTMP_PUBLIC_HOST`. Make it per-node/region + handle failover. WS/MJPEG ingest is
   origin-bound (rework needed).
7. **Edge WebRTC fan-out** (HIGH value, HIGH effort). LiveKit OSS **does not cascade** — media
   goes direct from the owning node's IP, but there's no per-viewer steering and no relay to a
   viewer-near edge. Bounded by an upstream LiveKit-Cloud capability. Region-aware `wsUrl` at
   token-mint is the cheap first step.

---

## 5. Login-lock + standalone↔cluster conversion + master promotion

**Key premise correction:** **edges run NO core today** (only livekit+ingress+egress + a
heartbeat timer). So "an edge serves the portal but blocks login" first requires making edges
**run a core** (the heavy enabling change, "A0"). *(Note: on our current test cluster, node
`media02`/.11 already runs a full stack incl. a core — a convenient place to prototype.)*

**No role concept exists in core today** — standalone and master are indistinguishable; edge
isn't representable. Design: a DB-driven role.

- **Role source of truth**: `_streamhub_meta` KV (already exists) → `node_role`
  (`standalone|master|edge`, default standalone) + `master_url`. Seed from env
  `STREAMHUB_NODE_ROLE`/`STREAMHUB_MASTER_URL` on first boot. New `NodeRoleService` in
  `ClusterModule` (direct SQL, avoid touching scaffolder-owned `shared/`).
- **Login lock (edges)**: one choke point — `AuthService.requireSecret()` (every mint path:
  login, signup, magic-verify, break-glass) throws `ForbiddenException('cluster_edge_login_
  disabled')` when `isEdge()`. Expose `nodeRole/masterUrl/loginEnabled` on the existing
  `GET /auth/config` (public, already read by the login page). SPA shows a "manage at the master"
  screen instead of the form. **LOW risk**; standalone/master both pass the check so a standalone
  "is its own master" for free.
- **Conversion endpoints** (new, on `ClusterController`):
  - `POST /cluster/join-master {masterUrl, clusterToken, nodeName}` → call the master's join,
    store role=edge + master_url, rewrite `/etc/streamhub/heartbeat.env`. Runtime for login;
    media plane needs a container recreate.
  - `POST /cluster/leave` → role=standalone, clear master_url, best-effort de-register.
  - `POST /cluster/nodes/:id/promote` → the hard one.
- **Master promotion (the sharp edge):** the master holds the **only** copy of the global SQLite
  (tenants/users/apps). No replication → promotion is **restore-then-flip**: restore a backup of
  the old master's `streamhub.db` onto the new master (backups machinery exists), then flip roles
  + re-point edges. **Refuse to promote a node with zero tenants/apps unless `--force`.**
  Edges can't be pushed config (they only *call* the master) → re-pointing is **edge-initiated**
  (emit a paste-able `join-master` command per edge).
- **Risks**: split-brain (fence the old master first + rotate token); heartbeat env lives outside
  the DB (must be rewritten); media-plane re-point needs a container recreate; stale local JWTs on
  a converted edge (optionally gate `validateJwt` too, but keep `sk_` tokens working).

**Implementation sequence** (risk-flagged): 1) `NodeRoleService` + KV [LOW] → 2) `/auth/config`
role fields [LOW] → 3) login block in `requireSecret()` [LOW] → 4) SPA edge screen [LOW] →
5) `join-master`/`leave` [MEDIUM] → 6) installer: edges run core + proxy [HIGH, the A0 enabler] →
7) `promote` + re-point [HIGH, needs restore-then-flip].

---

## 6. Recommended overall sequence

1. **Security P0/P1** (contained, high-severity): stop vending secrets in `join`, TLS-enforce,
   rate-limit + auto-ban the token check, per-node tokens.
2. **Role model + login-lock + standalone↔cluster conversion** (steps 1-5 above) — the explicit
   product asks, testable on the current cluster.
3. **S3-as-transport (#0)** — the distribution unlock + fixes the recording/HLS bugs.
4. **VOD transcode offload (#1)** + **HLS CDN cache (#2)**.
5. **Scheduler (#5)** → **GPU grid GRID-1..3 (#3)** (test with real GPU nodes) → **record-on-node
   (#4)** → **ingest (#6)** → **WebRTC edge (#7, product decision)**.
6. Installer A0 (edges run core) + master `promote` (restore-then-flip) last, with care.
