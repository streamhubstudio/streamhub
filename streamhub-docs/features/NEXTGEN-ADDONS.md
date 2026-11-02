# Next-gen add-ons — Vision · Grid · Babel · Semantic Search

> **Historical note:** the TS citations here (`plugin.contract.ts`, `_templates/`, `*.spec.ts`) refer to the 2.x Node core (tag `2.24.0`). In the Go core the contract is `streamhub-core-go/internal/plugins/contract.go` + `grid.go`, and a new add-on starts as a decoupled app package (`streamhub.app.json`) or a `builtins.json` entry — see §5.

> **Status: scaffolding + contracts, not products.** This document is the
> design for the four next-generation add-ons and the platform extension
> points that make them buildable **without re-architecting**. The typed
> seams described here are already in the codebase and locked by tests; the
> AI pipelines themselves are deliberately NOT implemented. Every remaining
> gap is tagged with a TODO id (`GRID-1` … `GRID-4`, plus per-product TODOs)
> so a build wave can pick them up one by one.

| Product | One-liner | Manifest stub | Worker |
|---|---|---|---|
| **StreamHub Vision** | Retail & CCTV intelligence (counting, zones, dwell, heatmaps) | `_templates/vision/` (2.x, tag `2.24.0`) | `vision-worker/` (TODO) |
| **StreamHub Grid** | Bring-your-own-GPU edge compute for plugin workers | `_templates/grid/` (2.x, tag `2.24.0`) | none (infrastructure + console) |
| **StreamHub Babel** | In-box live captions & AI dubbing | `_templates/babel/` (2.x, tag `2.24.0`) | `babel-worker/` (TODO) |
| **Semantic Search** | Natural-language search over live+VOD, auto-highlights | `_templates/semantic-search/` (2.x, tag `2.24.0`) | `semsearch-worker/` (TODO) |

---

## 1. The pattern we generalize — edge processing already ships

The `yolo` and `deface` plugins ARE the edge-processing pattern, end to end:

```
                      ┌──────────── origin node ────────────┐
RTMP/WHIP/RTSP ─► LiveKit SFU ─► HLS /hls/<app>/<room>/…    │
                      │                 │                    │
                      │                 ▼ (sampled frames)   │
                      │    worker process (Python, spawned   │
                      │    by the plugin framework via       │
                      │    worker.spawn(ctx))                │
                      │                 │ results (JSON)     │
                      │                 ▼                    │
                      │    POST /apps/:app/plugins/:id/live  │
                      │    (per-start ingest token)          │
                      └───────────────┬─────────────────────┘
                                      ▼
                     player overlay polls GET :id/live
                     and renders ON TOP of the main feed
```

Three properties make it generalizable:

1. **The core never knows what a worker is.** A plugin only declares a pure
   `worker.spawn(ctx) → { command, args, env }`; the framework owns the
   lifecycle (start/stop/status/logs). Swapping *where* that process runs
   does not change the plugin contract.
2. **Results re-enter through narrow, authenticated channels** (live-data
   channel, callbacks, LiveKit data messages) — not through shared state.
3. **The player is the compositor.** Overlays (`ui: 'player-overlay'`) draw
   results over the main feed client-side, on the dashboard players AND the
   anonymous `/play`/`/embed` pages.

**Grid = the same pattern with the worker on a different box.** Everything
else (config schema, ingest token, overlay, callbacks) is reused as-is.

---

## 2. The GRID contract (typed, shipped)

### 2.1 Worker placement — `plugin.contract.ts`

`PluginWorkerDescriptor` gained two optional, defaulted fields (the contract
file plugin authors import; extension is additive — **every pre-existing
plugin keeps its exact behavior with zero edits**):

```ts
worker: {
  spawn(ctx) { ... },              // unchanged, still the whole spawn story
  placement: 'grid',               // NEW — 'local' (default) | 'grid'
  grid: {                          // NEW — requirements, only with 'grid'
    gpu: true,                     // hard filter
    minVramGb: 8,                  // hard filter (implies gpu)
    capabilities: ['cuda','whisper'], // hard filter (⊆ node's advertised tags)
    regions: ['eu'],               // SOFT preference — reorders, never excludes
  },
}
```

- `PluginManifest.workerPlacement` (`'local' | 'grid'`) is serialized to the
  marketplace API so the dashboard can badge "runs on GRID" plugins.
  `toManifest()` defaults it to `'local'`.
- `WorkerState.placement` reports the **effective** placement of a run —
  always `'local'` until GRID-1 ships (a grid request that can't be
  dispatched falls back, and the fall-back is written to the plugin's system
  logs).
- `PluginWorkerContext` gained `node?` (identity of the node the worker is
  placed on) and `originUrl?` (public base URL of the origin, for a remote
  worker to reach the ingest endpoints). Both are `undefined` on the local
  path — existing plugins never see them.
- The registry **validates** the new fields at discovery (bad `placement`,
  orphan `grid` block, malformed requirement shapes → plugin skipped with a
  logged reason, never a crash).

### 2.2 GRID node registry — reuses the cluster `nodes` table verbatim

No new tables, no new endpoints. A cluster node (joined via the installer's
`--join` flow) becomes a **grid node** by advertising a `grid` block inside
its regular heartbeat stats (`POST /api/v1/nodes/:id/heartbeat`, ≤4KB blob):

```json
{ "cpu": 0.12, "grid": { "gpu": true, "vramGb": 24,
                          "capabilities": ["cuda", "yolo", "whisper", "clip"] } }
```

`PluginGridService` (`modules/plugins/plugin-grid.service.ts`) filters the
registry down to **active + non-stale (≤90s heartbeat) + grid-advertising**
nodes and matches a worker's requirements against them (`matchGridNode` is a
pure, exported, unit-tested function; deterministic order: preferred region →
larger VRAM → name).

> Example: VM200 (RTX 3090) joins the cluster with the standard installer,
> its heartbeat timer adds the `grid` block, and it instantly becomes
> selectable for every `placement: 'grid'` worker — no core redeploy.

### 2.3 Dispatch — the deliberate stub (what's real vs TODO)

`PluginWorkerManager.start()` for a `'grid'` worker today:

1. asks `PluginGridService.selectNode(requirements)` — **real, tested**;
2. calls `PluginGridService.dispatch(node, meta, ctx)` — **typed stub**: it
   always returns `{ dispatched: false, reason: '… TODO GRID-1' }`;
3. logs the pick + fall-back into the plugin's system logs and **spawns
   locally**, exactly like a `'local'` worker.

So declaring `placement: 'grid'` is always safe on a single-node install.

| Seam | What ships today | TODO |
|---|---|---|
| **GRID-1** remote dispatch | `dispatch()` signature typed against `PluginMeta`+`PluginWorkerContext`; call-site wired in the worker manager | Grid agent on the node (`<node.url>/api/v1/grid/workers`, cluster-token auth, edge role only) that receives `{pluginId, appName, config, ingestToken}`, resolves the spawn spec from its own registry (3.3.3; before, the resolved spec itself) and spawns/supervises it |
| **GRID-2** remote lifecycle | `WorkerState.placement`; manager logs the pick | Proxy start/stop/status/logs for remote entries through the agent; record the lease (node id + remote handle) on the worker entry |
| **GRID-3** result feed-back over the wire | `PluginWorkerContext.originUrl` field; per-start ingest token already rotates | Dispatch injects `STREAMHUB_INGEST_URL=<originUrl>/api/v1/apps/:app/plugins/:id/live` + the token; ingest accepted over the public plane (same token check, TLS via Caddy) |
| **GRID-4** ops surface | `_templates/grid` console manifest; `GET /api/v1/nodes` already lists nodes+stats | `/api/v1/grid/*` routes (grid nodes view, leases, per-plugin placement history) + the console UI |

Scheduler policy beyond first-match (least-loaded, region-affinity) is a
config seam on the `grid` console template — documented, not implemented.

---

## 3. Feed-back mechanism — how edge results re-enter the main feed

Three complementary channels, all shipped today; a worker (local or grid)
picks per payload class:

| Channel | Transport | Best for | Guarantees |
|---|---|---|---|
| **Live-data channel** (`POST/GET /apps/:app/plugins/:id/live`) | HTTP, worker-authenticated by per-start ingest token; players poll the public GET | "Latest state" overlays: boxes, masks, current counts | Latest-value-only, in-memory, 64KB cap; works for HLS/MJPEG players (no LiveKit connection needed) |
| **LiveKit data messages** (`LiveKitService.sendData`, topic `plugin:<id>` — helper `pluginDataTopic(id)` in the contract) | SFU data channel, push, sub-second | Event streams: caption cues, zone-cross events, highlight markers | Reliable or lossy; only reaches WebRTC-connected players; best-effort (a down SFU never fails the producer) — the `scheduled-live` agenda push is the shipped reference |
| **Room metadata** (`updateRoomMetadata`, already wrapped + tested in `modules/livekit`) | LiveKit room state | Durable, low-churn state every joiner must see: "captions available in es/en", active dubbing tracks | Persists for the room lifetime; delivered on join |

Plus the **`player-overlay` UI slot**: the overlay component (auto-mounted on
that app's players including anonymous `/play`/`/embed`) subscribes to data
messages when inside a LiveKit room context and falls back to polling the
live-data channel — the exact dual-transport pattern `scheduled-live` ships.

**Convention:** a plugin publishes its data messages on topic
`plugin:<pluginId>` (`pluginDataTopic()` in `plugin.contract.ts`) so overlays
subscribe by plugin id with no extra registry.

### Worked example — Babel captions on a GRID GPU node

```
1. Operator enables `babel` on app `tv` (room `live`), engine faster-whisper.
2. Framework start: placement 'grid' → PluginGridService picks node VM200
   (advertises grid.gpu + 'whisper'). [Today: dispatch stub → local fall-back;
   after GRID-1: spec POSTed to VM200's grid agent.]
3. babel-worker on the GPU node subscribes to the room's audio
   (BABEL_LIVEKIT_URL), runs streaming whisper, emits caption cues:
       { room:'live', seq:412, tStartMs:812_400, tEndMs:814_100,
         lang:'es', text:'bienvenidos al programa',
         translations:{ en:'welcome to the show' } }
4. Feed-back, per transport:
   a. data message on topic 'plugin:babel' → origin relays via
      LiveKitService.sendData(room, cue, { topic:'plugin:babel' })
      [worker POSTs the cue to the origin; TODO(babel): thin relay route or
      direct worker→SFU publish with a data-only participant token]
   b. the same cue POSTed to the live-data channel (STREAMHUB_INGEST_URL +
      token) → HLS viewers get captions via the public GET poll.
5. The babel player overlay (player-overlay slot, WebRTC + anonymous pages)
   renders cues from the data-message subscription, falling back to the poll;
   room metadata advertises available caption languages to new joiners.
6. Dubbing (optional): the worker synthesizes translated speech and publishes
   it as a NEW audio track 'es-dub' into the same room — viewers pick the
   dubbed track in the player instead of the original audio.
```

Latency budget: STT partials ≤1.5s behind live (config `maxCaptionDelayMs`),
data-message delivery is sub-second on the WebRTC path — captions land within
the HLS latency window, and roughly one utterance behind on pure WebRTC.

---

## 4. The four products

### 4.1 StreamHub Vision — retail & CCTV intelligence

**What it does.** Turns any camera app (RTSP/RTMP ingest, e.g. the StoreHub
5-cam layout) into retail/CCTV analytics: people counting on virtual lines,
zone occupancy, dwell time, traffic heatmaps. Dashboard `app-tab` with live
KPIs + a zone editor; events out through the existing signed callbacks/MQTT.

**Data flow.** Ingest → HLS sampled at `fps` → detector (person class) →
tracker (e.g. ByteTrack) → zone/line evaluation against the normalized
`zones` JSON → (a) current occupancy to the live-data channel, (b)
`line-cross`/`zone-enter`/`zone-exit` events as data messages on
`plugin:vision` + app callbacks, (c) aggregates persisted for the tab's
charts (TODO(vision): per-app `vision_metrics` table in `apps/<app>/app.db`).

**Open-source vs paid.**

| Concern | Open-source (default) | Paid API option |
|---|---|---|
| Detection | **YOLO (ultralytics) — already shipped** in `yolo-worker/`; OpenCV | AWS Rekognition, Azure AI Vision, GCP Video Intelligence (worker relays sampled frames) |
| Tracking/zones | ByteTrack/OC-SORT + pure geometry (own worker code) | usually bundled with the managed APIs |
| Faces/privacy | **deface/CenterFace — already shipped** (compose with Vision for GDPR displays) | — |

**Where it attaches.** `_templates/vision/` manifest (processor, `app-tab`,
`placement: 'grid'` + `{gpu, capabilities:['cuda','yolo']}`). Build order:
promote template → clone `yolo-worker/` into `vision-worker/` (the tracker +
zone math is the only new logic) → web tab with zone editor.

### 4.2 StreamHub Grid — bring-your-own-GPU edge compute

**What it does.** Lets an operator point a GPU box (their own hardware, a
rented 3090, a cloud GPU VM) at a StreamHub origin and have `grid`-placed
plugin workers run there — consuming the origin's feeds, feeding results
back. Not a plugin runtime of its own: **the product IS the placement
contract of §2** plus a console.

**Data flow.** `install.sh --join` registers the node (existing cluster flow)
→ heartbeat advertises `grid` capabilities → origin selects it for eligible
workers → (GRID-1) dispatch → remote worker reads the feed over HLS/WebRTC
from the origin's public URL → results back via §3 channels using
`ctx.originUrl` + ingest token.

**Open-source vs paid.** Grid is infrastructure: the "open-source" path is
your own hardware; the "paid" path is any rented GPU (the node doesn't care).
The console template is `_templates/grid/` (panel, `app-tab`, no worker).

**TODO seams:** GRID-1..4 (§2.3) — the entire remote half.

### 4.3 StreamHub Babel — live captions & AI dubbing

**What it does.** §3's worked example: real-time captions (source language +
translations) rendered as a player overlay on every player type, optional AI
dubbing published as extra audio tracks in the same room.

**Open-source vs paid.**

| Stage | Open-source (default) | Paid API option |
|---|---|---|
| STT | **faster-whisper** (GPU/CPU), **whisper.cpp** (CPU-friendly) | OpenAI Realtime STT, Deepgram, Azure Speech |
| Translation | NLLB / argos-translate on the worker | DeepL, Google Translate |
| TTS (dubbing) | **Piper** (fast), **Coqui XTTS** (voice-clone) | ElevenLabs, Azure Neural TTS |

**Where it attaches.** `_templates/babel/` (processor, `player-overlay`,
`placement:'grid'` + `{gpu, capabilities:['whisper']}`). TODO(babel):
`babel-worker/` package; caption overlay in `streamhub-web/src/plugins/babel/`;
the data-message relay path (§3.4a); dubbed-track publishing (worker joins
the room as a publish-only participant — token minting via the existing
LiveKit module).

### 4.4 Semantic video search + auto-highlights

**What it does.** "Show me when the red car appears" over live DVR + the VOD
library; automatic highlight-clip candidates while a stream runs. Dashboard
`app-tab` with a natural-language search box and a highlights reel — every
hit deep-links the player to `(room|vod, ts)`.

**Data flow.** Worker samples frames every `sampleIntervalSec` (+ optional
speech via the Babel STT stack) → embeddings → vector store → (a) highlight
markers as `plugin:semantic-search` data messages + callbacks, (b) index rows
for the query path. Query: tab → app-scoped REST route (TODO(semsearch):
`GET /apps/:app/semantic-search?q=…` — embed query, k-NN, return clips) →
player deep-link.

**Open-source vs paid.**

| Stage | Open-source (default) | Paid API option |
|---|---|---|
| Embeddings | **OpenCLIP**, SigLIP | cloud multimodal embedding APIs |
| Vector store | **sqlite-vec inside `apps/<app>/app.db`** (keeps the per-app SQLite invariant) | — (qdrant/pgvector are self-hosted scale-out, still OSS) |
| Speech index | Babel's whisper stack | cloud STT |
| Highlights | motion energy + audio peaks + object-burst voting (own worker code) | managed video-intelligence highlights |

**Where it attaches.** `_templates/semantic-search/` (processor, `app-tab`,
`placement:'grid'` + `{gpu, capabilities:['clip']}`).

---

## 5. The manifest templates — how to start a product

The four `definePlugin(...)` skeletons lived in
`streamhub-core/src/plugins/_templates/<id>/plugin.meta.ts` of the 2.x Node core
(branch `legacy/node-2.x`, tag `2.24.0`); each header carries the product-specific
build checklist. The Go core has no TS templates: to start one of these products,
write its meta as a decoupled app package (`streamhub.app.json`, see
[`../development/PACKAGE-FORMAT.md`](../development/PACKAGE-FORMAT.md)) — or, for an
in-tree built-in, a `streamhub-core-go/internal/plugins/builtin/builtins.json` entry —
using the template's fields. The registry validates `placement` / `requires` exactly
as before (`internal/plugins/grid.go`), and the worker exits until its package exists,
which is the first real build task.

## 6. Invariants & constraints honored

- **Additive only.** No existing plugin changed; `placement` defaults to
  `'local'`; manifests gained a defaulted field; `src/main.ts`,
  `src/app.module.ts`, `src/shared/**` untouched.
- **Per-app SQLite stays.** Grid reuses the global `nodes` table; product
  state (vision metrics, semantic index) is designed into `apps/<app>/app.db`.
- **Secrets discipline.** Provider keys are `secret` config fields — redacted
  in API responses, stripped from the public overlay config like every other
  plugin secret.
- **Tests as the gate.** New suites: `plugin-grid.service.spec.ts` (12) and
  `plugin-placement.spec.ts` (14) — see
  [testing/UNIT-TESTS.md](../testing/UNIT-TESTS.md).
