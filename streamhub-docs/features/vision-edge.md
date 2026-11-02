# Edge — distributed processing for the cluster

**Edge is how the StreamHub cluster PROCESSES.** It is not a single app — it is
the sum of every marketplace app that can run its worker EITHER co-located on
the origin OR distributed, per-stream, across one or more **edge nodes**. A
master (a normal StreamHub core) owns the UI, the API, the scheduler and the
event funnel; an edge node owns the CPU/GPU and the inference.

Eleven built-in Studio Apps are **edge-capable** today — the four **vision**
apps (**occupancy**, realtime people **counting**, **crowd** density,
**demography**) plus **lpr**, **presence**, **deface**, **yolo**, **safety-ppe**,
**perimeter** and **people-counter**. Each one declares `worker.edge: true` in
its manifest, which (a) badges it "Edge-capable" in the marketplace and (b) lets
an operator fan its worker out onto edge nodes through ONE generic per-app API —
`POST /apps/:app/edge/assignments { pluginId, streamId }` (see
[Edge-capable apps + the assignments API](#edge-capable-apps--the-assignments-api)).

The whole thing is built for **NAT**: an edge node holds ONE **outbound**
WebSocket to the master and opens **no inbound port**, has no public endpoint,
and needs no login. It dials out, registers, receives its work, and streams
telemetry and detections back over that same held socket + a couple of outbound
HTTPS calls.

Edge nodes + the control channel shipped in **2.13.0** (waves 1 + 2); the
**2.16.0** Edge-as-capability restructure split the old monolithic `vision`
Studio App into the four first-class apps above and generalized the assignments
API from a vision-only surface to every `worker.edge` plugin. This is the
canonical reference; the TAGS system has its own short doc ([tags.md](./tags.md)).

---

## Table of contents

- [What an edge node is](#what-an-edge-node-is)
- [Architecture](#architecture)
- [Node types + installer flag](#node-types--installer-flag)
- [The edge control channel (WebSocket)](#the-edge-control-channel-websocket)
- [Scheduler + balancing](#scheduler--balancing)
- [Watchdog + notifications](#watchdog--notifications)
- [Node storage view + commands](#node-storage-view--commands)
- [Per-app network I/O + threshold](#per-app-network-io--threshold)
- [Edge-capable apps + the assignments API](#edge-capable-apps--the-assignments-api)
- [The four vision apps](#the-four-vision-apps)
- [Migration: vision → the four apps](#migration-vision--the-four-apps)
- [TAGS](#tags)
- [Detections out](#detections-out-callback--mqtt--rotated-log--visiondb)
- [AI-API mode (demography)](#ai-api-mode-demography)
- [Co-located (single-node) mode](#co-located-single-node-mode)
- [Shared capture — one decode per source](#shared-capture--one-decode-per-source)
- [The edge runtime + install](#the-edge-runtime--install)
- [Agent relationship (RTSP via NAT)](#agent-relationship-rtsp-via-nat)
- [License (AGPL)](#license-agpl)
- [REST API](#rest-api)
- [Tests](#tests)

---

## What an edge node is

An **edge node** is a StreamHub install with `--node-type edge`. It:

- **joins** the master's cluster (registers in the global `nodes` table, keeps a
  60 s HTTP heartbeat) exactly like a `common` node, but
- runs **no public media plane** — no LiveKit, no ingress, no egress, no
  dashboard login (`STREAMHUB_NODE_ROLE=edge` disables login; manage it from the
  master);
- dials the master's **edge control WebSocket** out over `wss` and keeps it
  open, and
- runs a **worker-host runtime** that receives per-`(app × plugin × stream)`
  assignments over that socket and supervises one worker process each. Every
  frame carries a fully-resolved `spawn` spec (command + args + env), so the
  runtime executes it **verbatim** — it never needs to know which plugin it is
  hosting. For the four vision apps that runtime is the
  **`streamhub-vision-edge`** package; the other edge-capable apps ship their
  own worker, dispatched over the same channel.

Because everything is outbound, an edge can live behind NAT / CGNAT / a
residential router with zero port-forwarding. The only reachability requirement
is that the edge can reach the master's HTTPS domain.

---

## Architecture

```
                    ┌──────────────── MASTER (StreamHub core) ───────────────┐
  Agent (LAN/NAT)   │  WS control  /api/v1/edge/ws  ◄── edge dials OUT (wss) │
  RTSP→RTMP push ──▶│  ingest → HLS                ──── assignments/commands ─┼──► EDGE NODE(s)
                    │  edge-capable apps (UI + API)     telemetry/heartbeat ◄─┤    worker-host runtime
                    │  scheduler (RR / % + VRAM cap)                          │    pulls HLS (https out)
                    │  reconcile: active streams → edge                      │    runs the resolved spawn
                    │  watchdog → notifier fan-out                           │    (YOLO11 / InsightFace / …)
                    │  tags + per-stream settings                            │    POSTs events ──────┐
                    │  events: callback + MQTT + rotated log + per-app db  ◄──┼───────────────────────┘
                    └────────────────────────────────────────────────────────┘
  Co-located: the SAME worker runs ON the master host via the plugin worker lifecycle (no WS, no edge box).
```

The edge never opens a listening socket. Media flows **to** the edge as an HTTPS
pull of the master's HLS (`/hls/<app>/<room>/index.m3u8`); results flow **from**
the edge as batched HTTPS POSTs to the app's framework event endpoint
(`STREAMHUB_EVENTS_URL`); control rides the single held WebSocket.

---

## Node types + installer flag

The `nodes` registry gained two append-only columns:

- **`type`** — `common` (full media node, the default) or `edge` (worker/compute
  node);
- **`weight`** — relative scheduling weight for the `weighted` policy (default
  `100`, i.e. equal share).

The one-liner installer selects the shape:

```bash
# a full media node joining a master (default)
curl -fsSL <installer> | sudo bash -s -- --join --master-ip <ip> ...

# a Vision Edge node — joins + heartbeats + runs the vision runtime, no media plane
curl -fsSL <installer> | sudo bash -s -- --join --master-ip <ip> --node-type edge ...
```

`--node-type` is `common` (default) or `edge`; anything else aborts the install.
An `edge` install **skips** the LiveKit / ingress / egress compose services,
keeps the 60 s heartbeat timer, and installs the edge runtime systemd unit (see
[The edge runtime + install](#the-edge-runtime--install)).

A `common` node can be retyped to `edge` (or its `weight` changed) live from the
master, no reinstall:

```
PATCH /api/v1/edge/nodes/:id   { "type": "edge", "weight": 150 }
```

An edge node is a **general worker-host node**: any **edge-capable** plugin (the
four vision apps, yolo, lpr, presence, deface, safety-ppe, perimeter,
people-counter) can be assigned to it through the same channel. Because each
worker is a pure env-driven process resolved from its own `worker.spawn(ctx)`,
declaring `worker.edge: true` is all a plugin needs to become edge-assignable —
no per-plugin edge code.

---

## The edge control channel (WebSocket)

A single held WebSocket per edge node at **`/api/v1/edge/ws`** on the core's
HTTP server (hung off the `upgrade` event, the same raw-`ws` pattern as
ws-ingest — no socket.io, no `main.ts` change). It carries JSON frames both
ways.

### Auth (the upgrade handshake)

The edge connects to `wss://<domain>/api/v1/edge/ws?nodeId=<id>` and presents
**its own node secret** (3.3.4+, vended by the join — see
[INSTALL-NODE.md § Per-node credential](../operations/INSTALL-NODE.md#per-node-credential-334))
as the `X-Node-Secret` header, or in `X-Cluster-Token` / `?token=` (the carriers the
current runtime uses). The raw cluster token still passes only while
`STREAMHUB_CLUSTER_LEGACY_TOKEN` is on (warned). The upgrade is authorized before
the socket is accepted:

| Condition | Response |
|---|---|
| `STREAMHUB_CLUSTER_TOKEN` unset | `503` cluster disabled |
| wrong / absent credential, or another node's secret | `401` (timing-safe compare, same util as the cluster HTTP plane) |
| missing `nodeId` | `400` |
| `nodeId` not in the `nodes` table | `404` unknown node |
| all good | `101` Switching Protocols |

So **`STREAMHUB_CLUSTER_TOKEN` guards the edge WS** just as it guards
`POST /cluster/join`. A node must already exist in the registry (it joined over
HTTP first) before its socket is accepted.

**One connection per node** — a newer connection replaces an older one (the old
socket is closed with `4409 replaced by newer connection`).

### Frames

```
edge → master : register · telemetry · assignment_status · cmd_result ·
                log_tail_result · pong
master → edge : assign · revoke · cmd · log_tail · ping
```

- **register** — `{role, agentVersion, capabilities[]}` on connect; freshens the
  node heartbeat and re-offers any parked assignments.
- **telemetry** — `{stats:{cpu, mem, disk, grid:{gpu, vramGb, vramFreeMb,
  gpuName, capabilities}}}` every 15 s; persisted onto the node's registry row
  (drives the storage view + the scheduler's VRAM math).
- **assignment_status** — `{id, status: running|stopped|failed, detail?}` — the
  edge reporting the state of a worker it was assigned.
- **assign / revoke** — the scheduler placing / pulling one (app × plugin ×
  stream) workload, carrying a resolved `spawn` spec built by the generic spawn
  resolver (see [Assignment spawn](#assignment-spawn)).

### Keepalive

The master pings every **15 s**; **3 missed pongs** ⇒ the connection is
considered dead and terminated (the `close` event then finalizes it). The last
disconnect timestamp is remembered for the failover grace and failback.

### Commands (request → reply)

The master can drive a connected node and await its reply over the same socket
(default **5 s** timeout → `504`; not connected → `503`):

| Command | Effect on the edge |
|---|---|
| `restart` | restart the edge runtime service (systemd restarts the clean exit) |
| `reboot` | reboot the host (`systemctl reboot`) — **off by default**, gated by `VISION_EDGE_ALLOW_REBOOT` on the edge |
| `ping` | liveness probe |
| `log_tail` | return the tail of the edge runtime log (the master views remote logs — `GET /edge/nodes/:id/logs?lines=`, clamped 1–2000) |

Node commands are **audited** (written to the server log with the issuing
principal).

---

## Scheduler + balancing

The assignment unit is **(app × plugin × stream)** — one worker per stream for a
given edge-capable plugin. The scheduler builds a view of the cluster from the
`nodes` table + the live WS connections + the current assignment load, then
applies a pure placement function.

### Policies

- **`round_robin`** (default) — even spread over the eligible set (a monotonic
  cursor, deterministic given a sorted eligible set).
- **`weighted`** — each node's chance ∝ its `weight` over the eligible set;
  all-zero weights degrade to uniform.

The instance default is `STREAMHUB_EDGE_SCHEDULER_POLICY` (`round_robin` |
`weighted`); a single placement can override it per request.

### Eligibility + VRAM capacity

A node is **eligible** when it is: connected over WS **and** past any failback
grace, operator-`active`, of an allowed type (`edge`, or `common` too when
`STREAMHUB_EDGE_ALLOW_COMMON` is on), meeting the workload's GRID hardware
requirements (gpu / minVramGb / capabilities — delegated to the shared
`matchGridNode` so the edge and local-GRID planes agree), and **with VRAM
headroom**.

VRAM capacity uses Vision One's LoadBalancer math — reserve a buffer, budget per
stream:

```
max_streams = (vram_free_mb − 500) / 200
```

(`VRAM_RESERVE_MB = 500`, `VRAM_PER_STREAM_MB = 200`.) A CPU-only node (no
advertised free-VRAM figure) is unbounded here — the requirements filter already
keeps GPU-only work off it.

### Failover / failback / pending-retry

- **Failover.** The watchdog hands a node's orphaned assignments to the scheduler
  once the node has been WS-down past the **45 s** grace
  (`FAILOVER_GRACE_MS`). They are spread across the remaining eligible nodes
  (each placement increments a working load copy so they don't pile onto one
  node), honoring the VRAM guard; any that don't fit are parked **pending**.
- **Failback.** A node that flapped is held out for a **60 s** grace
  (`FAILBACK_GRACE_MS`) after reconnecting so work doesn't bounce straight back;
  a node that never dropped is placeable the moment it connects.
- **Pending-retry.** A pending assignment (nothing was eligible at create/failover
  time) is re-tried every **30 s** and offered to whatever now fits — so a
  healthy edge past its grace never sits next to a forever-pending assignment.
- **Re-offer on reconnect.** When a node reconnects, every pending/offered
  assignment for it is re-pushed (assignment frames are idempotent — the same
  frame on placement and on re-offer).

Assignment lifecycle: `pending → offered → running → stopped | failed`, or
`revoked` on operator delete.

---

## Watchdog + notifications

A periodic reaper (`modules/edge`, every **20 s**, unref'd) does two things:

1. **Liveness.** A node is `online` when it is connected over WS **or**
   HTTP-heartbeated within the **90 s** stale window; on every genuine flip it
   fires `node.online` / `node.offline` through the notifier seam. (The first
   observation seeds the baseline silently — no boot spam.)
2. **Failover.** Once a node has been WS-down past the grace, its work is failed
   over (above).

### Notifier fan-out

`node.online/offline` and the `network.threshold_*` events fan out through a
single **notifier** (`modules/notifications`) to every enabled channel. Each
channel is isolated (one failing channel never breaks the others), **rate-limited
per (app, channel, key) for 300 s**, and every notify is recorded in the app's
rotated log.

| Channel | Wiring |
|---|---|
| **callback + MQTT** | the app's signed webhook + the callbacks MQTT tap (self-no-ops when the app configured neither) |
| **email** | `EmailService.send` to the configured address |
| **Discord** | a Discord webhook `POST {content}` |
| **Telegram** | `sendMessage` via a bot token + chat id |

Node events are cluster-scope (no single app), so they go out on the
**env-configured** Discord/Telegram channels once (`notifyGlobal`) **and** to
every app whose `config.yaml` opts in with a truthy `cluster.notify`.

**Global env defaults** (see [ENV.md](../operations/ENV.md)):

```
STREAMHUB_NOTIFY_DISCORD_WEBHOOK       # Discord webhook URL
STREAMHUB_NOTIFY_TELEGRAM_BOT_TOKEN    # Telegram bot token
STREAMHUB_NOTIFY_TELEGRAM_CHAT_ID      # Telegram chat id
```

**Per-app override** — a `notifications:` block in the app's `config.yaml`
(merged over the env defaults; kept via the raw-config editor):

```yaml
notifications:
  enabled: true                 # master switch (default true)
  events: [all]                 # or an explicit event-name allowlist
  callback: { enabled: true }   # signed webhook + MQTT tap
  email:    { enabled: true, to: ops@example.com }
  discord:  { enabled: true, webhook: "https://discord.com/api/webhooks/…" }
  telegram: { enabled: true, bot_token: "…", chat_id: "…" }
```

A per-app channel is on when the block enables it **and** its target resolves
(webhook / bot+chat / email address present, from the block or the env default).

---

## Node storage view + commands

`GET /api/v1/edge/nodes` (global-scope) lists every registered node dressed for
the manager UI: `type` / `weight`, **live WS `connected`** vs `stale` (not
connected and unseen past 90 s), and the last telemetry blob
(`cpu / mem / disk / grid`). The dashboard renders storage/GPU bars per node from
that blob. From the same surface an operator can:

- `PATCH /edge/nodes/:id` — retype (`common`↔`edge`) / set `weight`;
- `POST /edge/nodes/:id/command` — `restart` / `reboot` / `ping` (audited);
- `GET /edge/nodes/:id/logs?lines=` — tail the remote runtime log.

---

## Per-app network I/O + threshold

Wave 1C added **per-app** media-plane byte accounting (not host-wide traffic):

- **egress** — HLS static delivery (a byte-counting middleware) + LiveKit egress
  webhook byte fields;
- **ingress/delivery** — a 60 s poll of the MediaMTX `/v3/paths/list` cumulative
  counters, deltaed per app (only when `STREAMHUB_MEDIAMTX_ENABLE` is on).

All collectors funnel into an in-memory accumulator flushed every 60 s into the
per-app `net_samples` table, keyed by UTC hour bucket. The dashboard shows a
**NetworkCard** (today / 24 h / 7 d, per-source breakdown, sparkline) fed by:

```
GET /apps/:app/net              # rolling summary + threshold posture
GET /apps/:app/net/history?hours=48
```

A per-app cap `network.threshold_gb_day` (config.yaml) is watched every 5 min by
a latched, hysteresis monitor (breach at ≥ threshold over the rolling 24 h,
recover below 90 %), emitting `network.threshold_exceeded` /
`network.threshold_recovered` through the callbacks funnel (→ webhook + MQTT, and
the notifier fan-out).

> **Known gaps (documented, out of Wave 1C scope):** ws-ingest (ESP32) bytes and
> the raw `:1937` passthrough fallback plane (MediaMTX OFF) are not counted;
> LiveKit **ingress** carries no cumulative byte field so ingest via LiveKit
> ingress is not metered here.

---

## Edge-capable apps + the assignments API

A plugin declares itself edge-capable with **one manifest flag** on its worker
descriptor:

```ts
worker: {
  spawn(ctx) { /* unchanged pure spec */ },
  edge: true,   // this worker can run DISTRIBUTED per-stream on edge nodes
}
```

`worker.edge` is distinct from `worker.placement: 'grid'`: `placement:'grid'` is
the LOCAL worker-hook asking to be dispatched to a BYO-GPU node for its ONE
app-wide run, while `edge` declares the worker safe to **fan out** — one
assignment per `(app × stream)` — across edge nodes. `toManifest` surfaces it as
a boolean `edge` field so the marketplace can badge **"Edge-capable"** apps, and
it **gates** the assignments API. The eleven built-ins that declare it: the four
vision apps (occupancy, counting, crowd, demography) plus lpr, presence, deface,
yolo, safety-ppe, perimeter and people-counter. `transcription` (file-based jobs,
not portable), `cockpit`, `fleet` and `streamflow` (no distributable worker) stay
local-only.

### The generic per-app assignments API

```
GET    /apps/:app/edge/assignments                 · config:read
POST   /apps/:app/edge/assignments { pluginId, streamId?, config?, policy? }  · config:write
DELETE /apps/:app/edge/assignments/:id             · config:write
```

`POST` validates that the plugin is **installed in the app** AND its meta
declares **`worker.edge === true`** (`400` otherwise), then schedules the
workload — parked **pending** when no edge node is eligible. RBAC mirrors the
plugin API (the app-config resource). A **global superadmin** surface still
exists at `/edge/assignments` (`?app=` filter) for cross-app operators; both
schedule through the same placement engine.

### Reconcile — active streams → edge

`EdgeReconcileService` (generalized from the old vision reconcile) sweeps every
app every **30 s**, but **only when ≥1 edge node is connected** — otherwise the
co-located worker-hook already covers the app and creating assignments would just
park them pending. For each installed + enabled edge-capable plugin whose
required config validates, it mirrors the app's **active rooms** onto assignments
— one row per `(plugin × stream)` with a `config.room` override, so a
single-room worker (lpr / yolo / a vision model / …) runs N times, once per
stream, spread across nodes. Streams that ended (or a plugin that was disabled)
get their stale assignments revoked. Best-effort: a bad app/plugin is skipped,
never thrown.

### The generic spawn resolver

When the scheduler places any assignment it resolves a real `spawn` spec through
`GenericSpawnResolver` — **no per-plugin special-casing**. It calls the plugin's
own `worker.spawn(ctx)` against a **remote** context (`originUrl` = the origin
public base — a remote edge cannot use loopback), exactly like the grid path,
then injects the framework EDGE env every remote worker needs to feed results
back: `STREAMHUB_APP`, `STREAMHUB_PLUGIN_ID`, `STREAMHUB_INGEST_URL` /
`STREAMHUB_EVENTS_URL` (off the origin base) and a **stable, scoped ingest
token** — `HMAC(cluster secret, "app:pluginId:room")`, identical across
re-offers, derivable server-side, never putting the raw cluster secret on the
wire. The plugin's own `spec.env` wins on conflict. The resolver never reads or
forwards plugin secrets (see [Assignment spawn](#assignment-spawn)).

---

## The four vision apps

The old monolithic `vision` Studio App retired in 2.16.0: its four models became
**first-class Studio Apps** — `occupancy`, `counting`, `crowd`, `demography` —
each `kind: 'app'`, `category: 'processor'`, `app-tab` UI, `version 0.1.0`,
`worker.edge: true`. Each owns its **own per-app db** (`occupancy.db`,
`counting.db`, `crowd.db`, `demography.db`) and is **exportable** as a standalone
bundle. All four share ONE Python package — the repo-root `vision-edge-runtime/`
(`export.workerDir: 'vision-edge-runtime'`) — invoked with `--model <id>`; each
decoupled package declares the same `streamhub.app.json` worker template (the 2.x
core shared a TS spawn builder). They are served by ONE parametrized in-core route
set (`streamhub-core-go/internal/visionapps`) at `/apps/:app/plugins/:visionApp/…`,
not four copies.

Each app's `configSchema` carries the knobs shared by every model — `device`
(`cpu` | `cuda`, default `cpu`), `fps` (default `3.5`), `confidence` (default
`0.35`) — and `demography` adds an `engine` (`local` | `openai` | `deepseek`)
and an `ai_api_key` secret. The per-stream geometry (zones / lines / roi) is NOT
in the manifest schema; it lives per room in each app's `stream_settings` table
(below).

### The four models

| Model | Engine | What it does | Config shape |
|---|---|---|---|
| **occupancy** | YOLO11 + ByteTrack (live HLS, adaptive sampler) | multi-**polygon** POI zones, persons **or** vehicles per zone, dwell **sessions**, count-based alert | `zones[]` |
| **counting** | YOLO11 + tracker at a **fixed 3.5 FPS** cadence | multi-**line** crossing → `count.in/out` + live `count.occupancy` (Vision One's `LineCrossingCounter`, verbatim) | `lines[]` + `pois?` |
| **crowd** | periodic HLS snapshot + YOLO head-count | per-polygon head count, **multi-cycle** threshold alert | `zones[]` |
| **demography** | InsightFace (local) or a vision API | per-face age / gender / emotion at an interval | `roi?` + `pois?` + engine |

Fixed cadence for counting is deliberate: ByteTrack/BoT-SORT swap IDs when the
frame gap varies, so counting must NOT use occupancy's adaptive sampler.

### Per-model config schemas (`config_json`)

The polygon/line/ROI schemas are the Wave-2 contract, validated + normalized in
core (points clamped to `[0,1]`, rounded to 4 decimals; a polygon needs ≥ 3
points; a line needs a positive length; unknown keys dropped). Note the domain
labels are Spanish (`personas` | `vehiculos`).

```jsonc
// occupancy / crowd
{
  "zones": [
    {
      "id": "z1",
      "tag": "entrance",              // tag slug (empty = none)
      "detect": "personas",           // personas | vehiculos
      "points": [[0.2,0.2],[0.8,0.2],[0.8,0.8],[0.2,0.8]],  // ≥3, normalized 0–1
      "confidence": 0.35,             // optional 0–1
      "alertLimit": 5,                // optional: occupancy alert threshold
      "alertAfterSec": 300            // optional: sustain before alerting
    }
  ]
}

// counting
{
  "lines": [
    { "id": "door", "tag": "main",
      "x": 0.5, "y": 0.5, "length": 0.6, "angle": 0,
      "inside": "bottom" }            // top | bottom | left | right
  ],
  "fps": 3.5,                         // fixed cadence (0.5–30)
  "capacity": 50,                     // optional: for count.occupancy
  "pois": [                           // optional POIs (see below)
    { "id": "aisle", "tag": "aisle-3", "points": [[0.2,0.2],[0.8,0.2],[0.8,0.8],[0.2,0.8]] }
  ]
}

// demography
{
  "engine": "local",                 // local | openai | deepseek
  "intervalSec": 120,                // 5–86400
  "roi": { "points": [[0.1,0.1],[0.9,0.1],[0.9,0.9],[0.1,0.9]] },  // optional legacy single region ≥3
  "pois": [                          // optional tagged POIs (see below)
    { "id": "till", "tag": "checkout", "points": [[0.6,0],[1,0],[1,1],[0.6,1]] }
  ],
  "aiPrompt": "…",                   // optional, ≤2000 chars (AI engines)
  "aiBudgetMonthly": 25              // optional monthly $ cap (AI engines)
}
```

### POIs — tagged polygon regions in every app (item 34)

`occupancy` + `crowd` gate by their **zone** polygons (which carry
class/alert semantics and already stamp every event with the zone `tag`).
`counting` + `demography` gained the same power through a lighter, model-agnostic
**POI** — a tagged polygon (`{ id, tag, points }`) that names a region:

- a **`pois`** array (normalized, ≥ 3 points, validated + normalized in core like
  zones — ids auto-fill `poi-1…`, unknown keys dropped);
- a detection **counts / applies only inside a POI** (point-in-polygon on the
  anchor — the foot for a counted crossing, the face-box centre for demography),
  reusing the runtime's `poi_for_anchor` geometry;
- every emitted event carries the **POI name** — `count.in` / `count.out` gain a
  `poi` field, `demography.face` gains a `poi` (and defaults its `tag` to it),
  exactly the way occupancy/crowd already carry `zone` + `tag`;
- **backward compatible**: no `pois` configured ⇒ the whole frame is used and
  `poi` is `null` — existing configs are unchanged. The web zone-editor is
  reused: all four apps draw POIs with the same `PolygonEditor` (counting draws
  its lines + POIs on one canvas; demography's editor is now multi-POI, folding a
  legacy single `roi` into one POI on load).

The runtime core `vision_edge.zones` owns the shared `NamedPolygon` / `parse_pois`
/ `poi_for_anchor`, so any future model gets POIs for free. One caveat: the
demography **AI engines** return a whole-frame aggregate (no per-face box), so
POIs are **not** applied per-face there — POI gating is a **local**-engine
feature; the AI engine ignores POIs (whole frame).

### Per-stream settings resolution

A stream's effective config for a model is a **deep merge**, lowest precedence
first (arrays replace wholesale; objects merge recursively):

```
model defaults  →  tag configs (streams.tags → tags.config_json per-model block)  →  per-stream override
```

Per-stream overrides live in each app's own **`<model>.db.stream_settings`**
(PK `room` — the model is now the database, so the old `model` column is gone),
edited over the API and from the app tab's **polygon/line editor** (drawn over
the live player). On a settings change the master **re-pushes** the resolved
config to any matching edge assignment.

### <a id="assignment-spawn"></a>Assignment spawn

When the scheduler places an assignment, `GenericSpawnResolver` resolves the spec
by calling the plugin's own `worker.spawn(ctx)` against a remote ctx and merging
in the framework EDGE env. For an `occupancy` assignment on room `office` the
vision app's spawn builder produces:

```jsonc
{
  "command": "python3",
  "args": ["-m", "vision_edge", "--model", "occupancy", "--room", "office"],
  "env": {
    // — framework EDGE env, injected by GenericSpawnResolver —
    "STREAMHUB_APP": "live",
    "STREAMHUB_PLUGIN_ID": "occupancy",
    "STREAMHUB_EVENTS_URL": "https://<domain>/api/v1/apps/live/plugins/occupancy/events",
    "STREAMHUB_INGEST_URL": "https://<domain>/api/v1/apps/live/plugins/occupancy/live",
    "STREAMHUB_INGEST_TOKEN": "<hmac(cluster secret, 'live:occupancy:office')>",
    // — the vision app's own spec.env (buildVisionSpawn, edge branch) —
    "VISION_MODE": "edge", "VISION_APP": "live", "VISION_MODEL": "occupancy",
    "VISION_ROOM": "office", "VISION_DEVICE": "cuda", "VISION_FPS": "3.5",
    "VISION_CONFIDENCE": "0.35",
    "VISION_HLS_URL": "https://<domain>/hls/live/office/index.m3u8",
    "VISION_CONFIG_JSON": "{…resolved zones/lines/roi…}"
  }
}
```

The HLS + events URLs are built off the **origin public base** (a remote edge
cannot use loopback). The only secret in the frame is the **stable, scoped ingest
token** — `HMAC(cluster secret, "app:pluginId:room")`, derivable server-side for
later verification and identical across re-offers. The demography **AI API key is
deliberately withheld** from every edge frame (the edge branch of
`buildVisionSpawn` never sets `VISION_AI_API_KEY`; it stays on the master, so
edge demography with an API engine is a co-located concern). Because the resolver
is fully generic, **any other edge-capable plugin** (lpr, presence, …) resolves
the same way — its own `worker.spawn(ctx)` builds the spec, the framework env is
merged over it, and its secrets stay on the master.

---

## Migration: vision → the four apps

Upgrading to 2.16.0 retires the `vision` plugin automatically. A one-shot,
**idempotent, non-destructive** boot migration (`VisionMigrationService`, on
application bootstrap) runs for every tenant app that still carries a `vision`
install row:

1. **Backup.** `apps/<app>/vision/vision.db` is copied to a single-file
   `vision.db.pre-split.bak` via `VACUUM INTO` (WAL-safe; skipped if the backup
   already exists).
2. **Split.** The db is fanned out into `apps/<app>/<model>/<model>.db` — each new
   db gets its own events table + the `stream_settings` rows for its model
   (`INSERT OR IGNORE`, so a re-run never duplicates; the old `model` column is
   dropped in the split).
3. **Install the model-apps.** Every model whose `<model>_enabled` flag was true
   (occupancy defaults on) is installed, carrying the shared knobs
   (`device` / `fps` / `confidence`, plus demography's `engine` / `ai_api_key`);
   `enabled` = that flag AND the old vision plugin's own enabled state.
4. **Re-point assignments.** `edge_assignments` rows with `plugin_id = 'vision'`
   are updated to the per-model `plugin_id` (from `config_json.model`), or revoked
   so the edge reconcile recreates them.
5. **Drop the old row.** The `vision` install row is removed — which is also what
   makes the migration idempotent: a second boot finds no `vision` install and
   no-ops. Each app is isolated in its own try/catch, so one bad app never bricks
   boot.

Migrated model-apps are marked `worker_desired = 'running'` and their workers are
resumed in the **same** boot, so the upgrade itself never leaves detection off
(the global boot-resume skips the retired `vision` id, which no longer has a
meta). Existing polygon/line/roi settings and event history survive; the
`.pre-split.bak` is left in place for manual rollback.

---

## TAGS

Streams and rooms carry **tags** — operator-created entities with a
`config_json` settings blob. A tag of kind `store` (or `zone` / `custom`) carries
per-model vision settings that merge into every stream it is applied to (the
middle layer of the resolution above). Every detection event carries its
stream's tags. Full CRUD + apply API. See the dedicated doc: **[tags.md](./tags.md)**.

---

## Detections out (callback + MQTT + rotated log + per-app db)

Every detection the runtime produces is POSTed to the framework event channel
(`STREAMHUB_EVENTS_URL`, ingest-token auth) under one of the app manifest's
allowlisted event names — the channel **rejects anything else**, so a worker can
never spoof core events. Each event then lands in **three** places (all
best-effort, never throws):

1. the app's **signed callbacks** (webhook + MQTT tap);
2. the per-app **rotated log** — `<DATA_DIR>/apps/<app>/logs/app.log`, one line
   per event, `source` = the emitting app id (a `RotatingFileStream`, size/age
   rotation via `LOG_MAX_BYTES` / `LOG_MAX_FILES` / `LOG_RETENTION_DAYS`);
3. the matching model-app's **`<model>.db`** (`apps/<app>/<model>/<model>.db`) —
   bounded 30-day history, pruned on write.

### Event allowlist

Every payload carries the common envelope `{app, room, tags, nodeId, model, ts}`
plus specifics:

| Event | Specifics |
|---|---|
| `occupancy.session_started` / `occupancy.session_ended` | `{zone, tag, kind:'personas'\|'vehiculos', durationSec?}` |
| `occupancy.alert` | `{zone, tag, kind, occupancy, limit, sinceSec}` |
| `count.in` / `count.out` | `{line, tag, trackId, confidence, poi?}` |
| `count.occupancy` | `{inside, capacity?, tag?}` |
| `crowd.count` | `{zone, tag, count}` |
| `crowd.threshold` | `{zone, tag, count, threshold, cycles, snapshotUrl?}` |
| `demography.face` | `{age, ageRange, gender, genderConfidence, emotion, emotionConfidence, tag?, poi?, engine:'local'\|'openai'\|'deepseek'}` |

(`poi` is the name of the POI a detection fell in — `null`/absent when no POIs
are configured; see [POIs](#pois--tagged-polygon-regions-in-every-app-item-34).)

### Per-app db tables

Each model-app owns its own SQLite db — one event-history table plus a
`stream_settings(room, config_json)` per-room override table:

| App | db | Event table |
|---|---|---|
| occupancy | `occupancy.db` | `occupancy_sessions` |
| counting | `counting.db` | `count_events` |
| crowd | `crowd.db` | `crowd_events` |
| demography | `demography.db` | `demography_events` |

Histories are pruned to 30 days on write. Read from the app tab via
`GET /apps/:app/plugins/:visionApp/events?limit=` (`:visionApp` = the model id)
and the overview tiles.

---

## AI-API mode (demography)

Demography defaults to a **local** model (InsightFace **buffalo_l**: genderage +
RetinaFace, with Vision One's asymmetric gender thresholds and an HSEmotion
remap; the InsightFace import is lazy). Set the model's `engine` to **`openai`**
or **`deepseek`** to send periodic snapshots to that provider's Chat Completions
**vision** endpoint instead:

- per-model `engine: local | openai | deepseek` + an operator `aiPrompt` +
  `aiBudgetMonthly` cap;
- the runtime base64-encodes the snapshot, sends it with the prompt, parses the
  JSON reply into the same `demography.face` record;
- a **monthly budget guard** persists estimated spend and hard-stops over
  `aiBudgetMonthly` — the API is never called once the cap is hit.

The API key is provided to the runtime out-of-band (`VISION_AI_API_KEY`, kept on
the master for co-located mode); it is **never** placed in an edge assignment
frame. AI engines need neither InsightFace nor a GPU.

---

## Co-located (single-node) mode

Every vision app also runs **on the master host** through the plugin worker
lifecycle — no edge box, no WS. Each app's `worker.spawn(ctx)` runs ONE
**`worker-manager`** for THAT model (`python -m vision_edge --mode worker-manager
--model <m> --app <app>`): it discovers the app's active rooms from the HLS dir
and runs the model per room via the shared `AssignmentSupervisor`, reading
per-room settings from that app's own `<model>.db` `stream_settings` (read-only).
This is the **one-worker-per-app** pattern lpr / presence follow — the old
multi-model manager (one process running every enabled model off a single
`vision.db`) is gone; each installed model-app spawns its own single-model
manager. It resolves the `VISION_*` env from the app's config (`device` / `fps` /
`confidence`, plus `engine` / `ai_api_key` for demography); the framework owns
start/stop/status/logs and injects `STREAMHUB_EVENTS_URL` /
`STREAMHUB_INGEST_TOKEN`. The demography API key stays on this host (co-located
loopback) and is **never** placed in an edge frame. Single-node installs get
every installed model with zero extra infrastructure, and the detection funnel
(callback + MQTT + rotated log + `<model>.db`) is identical.

Distributed edge placement is a **separate** path (`edge_assignments` + the
generic spawn resolver), not this one. Either way a plugin's worker now
**survives a core restart** — see
[plugins.md → Workers survive a core restart](plugins.md#workers-survive-a-core-restart).

---

## Shared capture — one decode per source

Running crowd + counting + occupancy on the **same camera** used to spawn N
worker processes, each opening its OWN `HlsFrameReader` (cv2.VideoCapture) that
pulls **and decodes** the same HLS stream: **N× network pull + N× decode**.
Inference is inherently per-model; the pull + decode are not. The runtime can now
run those models **in ONE process** that decodes the source **once** and fans
each decoded frame out to every model consumer.

### The multiplex worker

```
python -m vision_edge --mode worker --models occupancy,counting,crowd --room office
```

One `HlsFrameReader` for the source; a pure `SharedCapture` fan-out
(`vision_edge/capture.py`) holds one **cadence sampler per model** — occupancy's
adaptive skip, counting's fixed 3.5 FPS, crowd/demography's one-frame-per-interval
— and, per decoded frame, returns which consumers want it. Each consumer keeps
its own YOLO/InsightFace model (inference can't be shared across models), so the
cost of the Nth model is **only its inference**, never another decode.

Because the four vision models are **separate apps** (each its own events
endpoint + scoped ingest token), the multiplex carries a **per-model delivery
target** so each model's detections still route to the right app:

```jsonc
// VISION_MODELS=occupancy,counting,crowd   VISION_DECODE_FPS=5
// VISION_MULTIPLEX_JSON:
{
  "occupancy": { "config": {…zones…}, "eventsUrl": "…/plugins/occupancy/events", "ingestToken": "hmac(…,'app:occupancy:office')", "app": "live" },
  "counting":  { "config": {…lines…}, "eventsUrl": "…/plugins/counting/events",  "ingestToken": "hmac(…,'app:counting:office')" },
  "crowd":     { "config": {…zones…}, "eventsUrl": "…/plugins/crowd/events",     "ingestToken": "hmac(…,'app:crowd:office')" }
}
```

A missing per-model slot falls back to the base worker env — so a single-app
multiplex (or a lone `--model`) still works unchanged.

### Decode-fps cap (once per source)

`VISION_DECODE_FPS` caps the **decode** rate of the shared source ONCE (knob #3).
The reader `grab()`s every frame (cheap, no decode) and only `retrieve()`s
(decodes) at the cap, so a source feeding N models is decoded at most
`decode_fps`/sec **total**, and every model down-samples that capped stream to its
own cadence. `0` (default) decodes every available frame. A grabbed-but-skipped
frame still counts as **live** (no false stale-reconnect).

### The saving (honest)

Let a source host **N** models. Decode of a YOLO-sized frame is the dominant
non-inference cost; on CPU a 720p H.264 keyframe-GOP decode is ≈ **8–15 ms/frame**
and the HLS pull is one TCP stream per reader.

| | Before (N workers) | After (multiplex) |
|---|---|---|
| HLS pulls of the source | **N** | **1** |
| Decode passes | **N × decode** | **1 × decode** |
| Inference | N × infer | N × infer (unchanged) |
| Processes | N | 1 |

So on a 3-model camera the network pull and the decode CPU drop to **⅓** (a ~9 ms
saved per shared frame × 2 = ~18 ms/frame of decode removed at 3.5 FPS ≈ **60 ms/s
of CPU per camera**, before the RSS win of one process vs three). The inference
budget is untouched — that is the floor, and the multiplex reaches it.

### Co-located realization + the cross-node boundary

- **Co-located, same daemon, one source (the common case):** this is exactly
  where sharing pays off. The runtime multiplex is the engine; realizing it for
  the four co-located vision apps means the plugin framework spawns **one**
  multiplex worker per shared source (with the per-model tokens it already
  derives) instead of one worker-manager per app. That spawn wiring is the
  remaining core step — deferred only because it interacts with the pending
  vision-4 decoupling (`planning/VISION4-DECOUPLING-DESIGN.md`); the runtime side
  is complete and independently testable today.
- **Different processes / different nodes:** sharing is **impossible** across an
  OS-process or node boundary — a decoded frame is an in-RAM buffer, and the
  edge scheduler may place two models for the same room on two different edge
  hosts. Each such placement pulls + decodes independently. The multiplex only
  helps models that land in the **same** process; to benefit on edge, the
  scheduler must co-place same-source vision assignments and coalesce them into
  one multiplex spawn (same per-model-token shape as above) — a scheduler
  extension, not a runtime one.

---

## The edge runtime + install

The runtime is the repo-root **`vision-edge-runtime/`** Python package
(`vision_edge`). It imports **nothing** from the core — every input arrives via
env/args, results leave over HTTP and its own state files — so the identical code
runs as a plugin worker on the master or as a systemd service on a remote GPU
box.

### Run modes

| Mode | Command | Role |
|---|---|---|
| **worker** | `python -m vision_edge --model <m> --room <r>` | one model bound to one room (spawned by the edge supervisor, or by worker-manager); `VISION_APP` comes via env |
| **worker (multiplex)** | `python -m vision_edge --models <m1,m2,…> --room <r>` | SHARED CAPTURE: N models on ONE decode loop for one source (`VISION_MODELS` / `VISION_MULTIPLEX_JSON` / `VISION_DECODE_FPS`) — see [Shared capture](#shared-capture--one-decode-per-source) |
| **worker-manager** | `python -m vision_edge --mode worker-manager --model <m> --app <a>` | co-located single-node: runs ONE model (the `--model` / `VISION_MODEL` is required) across all of the app's active rooms via the shared `AssignmentSupervisor`, reading per-room settings from that app's own `<model>.db` (read-only). One per model-app — this is what each vision app's `worker.spawn(ctx)` runs. |
| **edge** | `python -m vision_edge --edge` | the long-lived daemon: WS client + supervisor; receives assignments and manages worker children itself |

The mode is chosen by `--edge` / `--mode {worker,worker-manager,edge}`; with none
of those it is inferred from the environment (a WS / master URL present ⇒ edge).
`SIGTERM` (how the framework stops a worker) becomes a clean shutdown.

### Edge daemon connection env (`STREAMHUB_*` / `VISION_EDGE_*`)

| Env | Meaning |
|---|---|
| `STREAMHUB_EDGE_WS_URL` | edge control WS (`wss://<domain>/api/v1/edge/ws`) — else derived from `STREAMHUB_MASTER_URL` |
| `STREAMHUB_CLUSTER_TOKEN` | cluster auth (rides `X-Cluster-Token`) |
| `STREAMHUB_NODE_ID` | this node's id in the master `nodes` registry |
| `VISION_EDGE_ALLOW_REBOOT` | permit the master's `reboot` command (`systemctl reboot`); **off by default** |
| `VISION_EDGE_LOG` | runtime log path the master's `log_tail` reads |
| `VISION_EDGE_CAPABILITIES` | advertised caps (default `vision,yolo`) |

The daemon sends `register` on connect, `telemetry` every 15 s (cpu/mem/disk via
stdlib + optional psutil, gpu/vram via `nvidia-smi`), replies to `ping`, and
handles `assign` / `revoke` / `cmd`(`ping`|`restart`|`reboot`) / `log_tail`.

### systemd unit

`install.sh --node-type edge` writes `/etc/streamhub/edge.env`
(`STREAMHUB_MASTER_URL` / `_CLUSTER_TOKEN` / `_NODE_ID`) and a
`streamhub-edge.service` unit **gated on the runtime binary being present**:

```ini
# /etc/systemd/system/streamhub-edge.service  (installed by install.sh)
[Unit]
Description=StreamHub Vision Edge runtime (dials the master WS control channel)
Wants=network-online.target
After=network-online.target
ConditionPathExists=/usr/local/bin/streamhub-vision-edge   # inert until the runtime is placed here

[Service]
Type=simple
EnvironmentFile=-/etc/streamhub/edge.env
ExecStart=/usr/local/bin/streamhub-vision-edge             # a venv shim: exec python -m vision_edge --edge
Restart=on-failure
RestartSec=5
Nice=5

[Install]
WantedBy=multi-user.target
```

The unit is **installed enabled but inert** — `ConditionPathExists` keeps it a
harmless no-op until the runtime is shipped to
`/usr/local/bin/streamhub-vision-edge` (a venv shim that runs
`python -m vision_edge --edge`). `systemctl restart` is exactly what the master's
`restart` command relies on.

### Minimum requirements

CPU-only is fine for a handful of streams; a GPU is the multiplier. YOLO11
resizes to 640 px for inference regardless of source resolution, so 720p vs 1080p
mostly changes decode cost.

| Resource | Minimum | Notes |
|---|---|---|
| CPU | 2 cores | yolo11n ≈ 80–150 ms/frame/core; budget **~0.5 core per stream** + headroom |
| RAM | 1.5 GB free / worker | CPU torch + ultralytics + opencv RSS ≈ 0.6–0.9 GB/process |
| Disk | ~2.5 GB deps | torch CPU wheels + opencv; `yolo11n.pt` (~6 MB) auto-downloads; the `[demography]` extra adds insightface/onnxruntime + buffalo_l (~300 MB) |
| GPU | optional | any CUDA GPU drops inference to < 10 ms/frame |

Base deps (`requirements.txt`): `ultralytics`, `lapx`, `opencv-python-headless`,
`numpy`, `websockets`. Optional extras: `[demography]` (insightface + onnxruntime
+ hsemotion), `[telemetry]` (psutil; a stdlib fallback exists). The demography
**AI engines** (`openai`/`deepseek`) need **none** of the local ML deps.

### GPU VRAM capacity

The scheduler and the runtime's telemetry share Vision One's LoadBalancer math —
reserve **500 MB** per node, budget **~200 MB per vision stream**:

```
max_streams = (vram_free_mb − 500) / 200
```

So a **Tesla T4 (16 GB, ~14.2 GB free)** hosts ≈ **68** streams by VRAM; in
practice compute caps it lower (a T4 runs yolo11n @720p at ~59 FPS → ~15–25
concurrent streams at 2–5 FPS sampling). The edge reports `grid.vramFreeMb` in
telemetry so the master never over-assigns.

---

## Agent relationship (RTSP via NAT)

Edge media ingest is **already NAT-solved** by the StreamHub Agent and needs no
new edge inbound path: the Agent (on the camera LAN) does an **RTSP → RTMP
outbound push** to the master's ingest, the master remuxes it to HLS, and the
edge runtime **pulls that HLS over HTTPS out**. Cameras never expose a port; the
edge never listens. See [fleet.md](./fleet.md) for managing the Agents and
[ingress.md](./ingress.md) for the RTSP-relay / RTMP-push ingest.

---

## License (AGPL)

The vision algorithms are ports of **Vision One** (`storehub-vision-one`):
the occupancy pipeline + POI-zone sessions, `LineCrossingCounter`, the crowd
`CrowdStateManager`, buffalo_l/softmax/emotion demography, and the adaptive
frame sampler — re-expressed over normalized coordinates and upgraded to
polygons + tags.

**YOLO11 (ultralytics) is AGPL-3.0**, so the `vision-edge-runtime` is licensed
**AGPL-3.0-or-later**. This is compatible with StreamHub's open-source model, but
note the copyleft if you distribute a modified runtime. **RT-DETR / YOLOX** are
documented as future non-AGPL swaps. The local demography engine adds InsightFace
(MIT) + HSEmotion (Apache-2.0); the AI-API engines need neither.

---

## REST API

Global-scope (edge manager), the generic app-scoped assignments surface, and the
four vision-app surfaces. Full tables in [../api/README.md](../api/README.md).

| Method + path | Scope | Purpose |
|---|---|---|
| `GET /edge/nodes` | global | list nodes: type/weight, live WS liveness, storage/GPU stats |
| `PATCH /edge/nodes/:id` | global | set `type` / `weight` |
| `POST /edge/nodes/:id/command` | global | `restart` / `reboot` / `ping` (audited) |
| `GET /edge/nodes/:id/logs?lines=` | global | tail the remote runtime log |
| `GET /edge/assignments?app=` | global | list assignments across all apps (superadmin) |
| `POST /edge/assignments` | global | schedule (app × plugin [× stream]) — superadmin |
| `DELETE /edge/assignments/:id` | global | revoke — superadmin |
| `GET /apps/:app/edge/assignments` | app · `config:read` | list this app's edge assignments |
| `POST /apps/:app/edge/assignments` | app · `config:write` | schedule an edge-capable plugin (`{ pluginId, streamId?, config?, policy? }`; validates `worker.edge`) |
| `DELETE /apps/:app/edge/assignments/:id` | app · `config:write` | revoke one of this app's assignments |
| `GET /apps/:app/plugins/:visionApp/overview` | app · `config:read` | events today, edge assignments, active streams |
| `GET /apps/:app/plugins/:visionApp/streams` | app · `config:read` | active rooms + tags + whether this model has a settings override |
| `GET/PUT /apps/:app/plugins/:visionApp/streams/:room/settings` | app · `config:read`/`write` | per-room settings (polygons / lines / roi) for this model |
| `GET /apps/:app/plugins/:visionApp/events?limit=` | app · `config:read` | recent detections from this model's `<model>.db` |

`:visionApp` ∈ `occupancy | counting | crowd | demography`. Edge assignments (the
old vision-only `/plugins/vision/assignments`) moved to the generic
`/apps/:app/edge/assignments`; nodes are cluster-scope (`GET /edge/nodes` + the
dashboard's **Cluster → Edge** tab), no longer an app-scoped route.

---

## Tests

- **Core (`go test`, no infra):** `internal/edge` (covering what the 2.x jest suites did — gateway transport +
  auth, pure scheduler placement/capacity/failover, scheduler service, watchdog
  liveness/failover, assignment repository, the **generic spawn resolver** (7),
  the **app-scoped assignments controller** (8), the **edge reconcile** (4)) +
  `edge.e2e` (11); `modules/tags` (`settings-merge` 7, `tags.repository` 17) +
  `tags.e2e` (8); `modules/notifications` (`notifier.service` 6);
  `modules/net-metrics` (`hls-byte-counter` 9, `net-bucket` 7,
  `net-metrics.service` 12, `net-threshold-monitor` 7) + `net-metrics.e2e` (3);
  `modules/vision-apps` (`vision-settings` 15 — incl. counting/demography POIs,
  `vision.store` 8, `vision.sink` 3,
  `vision.service` 4, and the **vision→4-apps migration** `vision-migration.service`
  6) + `vision.e2e` (9); the shared spawn builder `_shared/vision-edge-spawn` (4)
  + a `plugin.meta` spec per vision app (occupancy / counting / crowd / demography,
  3 each); `app-plugins.repository` (11 — incl. the `worker_desired` column);
  `apps/apps-config-passthrough` (1). See [../testing/UNIT-TESTS.md](../testing/UNIT-TESTS.md).
- **Edge runtime (pytest, pure-logic — no torch/opencv/insightface/websockets):**
  `cd vision-edge-runtime && pytest` — **253** tests covering polygon zone
  membership + tagging, **POIs** (`NamedPolygon` / `parse_pois` / `poi_for_anchor`
  + counting/demography config parse + POI-stamped event payloads), the
  `LineCrossingCounter` port, fixed-cadence + adaptive sampler math, the
  **shared-capture fan-out** (`FrameRing` / `make_sampler` / `SharedCapture`
  dispatch + the HLS decode-fps cap grab/skip + `MultiplexConfig` per-model
  routing + the CLI `--models` set), crowd multi-cycle threshold, demography
  mapping + AI-response parsing + budget guard, event batching/spool, the WS frame
  codec + backoff + dispatch, supervisor restart caps/backoff, the **single-model
  worker-manager** (`--model` / `VISION_MODEL` required, per-app room fan-out,
  read-only settings), the pluginId-agnostic edge daemon (a non-vision
  assignment's argv runs verbatim), telemetry parsing + VRAM math, and config
  parsing.
- **Web (node:test + vitest):** `poly.util` POI parse/serialize + the shared
  `PolygonEditor` reuse (counting + demography draw POIs → normalized
  `config.pois` on Save).
