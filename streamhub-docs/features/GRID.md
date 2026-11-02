# StreamHub Grid — remote GPU worker offload (GRID-1..3)

> Bring-your-own-GPU: run a plugin's worker process on a remote edge node with a
> GPU instead of the origin. The origin dispatches *which* worker to run (plugin +
> app + config) to the node's **grid agent**, the node resolves the spawn spec from
> its own plugin registry, and the worker feeds results back over the public
> plane. If no eligible node is registered — or dispatch fails — the worker
> transparently falls back to a **local spawn**, so declaring `placement:'grid'`
> is always safe, even on a single-node install.

Related: [NEXTGEN-ADDONS.md](./NEXTGEN-ADDONS.md) (the typed placement seam),
[../operations/INSTALL-NODE.md](../operations/INSTALL-NODE.md) (joining a node),
[../architecture/CLUSTER-ROADMAP.md](../architecture/CLUSTER-ROADMAP.md) §4 #3.

## 1. The picture

```
  ORIGIN (core)                                   GPU NODE (core)
  ┌───────────────────────────┐                   ┌───────────────────────────┐
  │ PluginWorkerManager.start │                   │ GridAgentController        │
  │  placement:'grid'         │   POST /grid/     │  POST /grid/workers        │
  │  → selectNode()           │──workers──────────▶  (edge only, cluster token)│
  │  → dispatch(plugin,cfg)   │  {pluginId,app,   │  → GridAgentService        │
  │                           │   config,token}   │    resolves the spec here  │
  │                           │                   │  → PluginWorkerManager     │
  │  records the LEASE        │◀──{ id }──────────│    .startSpec()  (spawns)  │
  │  (nodeId, remoteId)       │                   │      the SAME lifecycle    │
  └───────────────────────────┘                   └───────────────────────────┘
        ▲  results (GRID-3)                              │ python worker
        └── POST /apps/:app/plugins/:id/live  ◀──────────┘ (HLS in, HTTP out)
            (STREAMHUB_INGEST_URL = origin public base + per-start token)
```

The grid node registry **reuses the cluster `nodes` table verbatim** — a node
becomes grid-eligible simply by advertising a `grid` block in its heartbeat
`stats` (no schema change, no new join step). `PluginGridService.listGridNodes()`
filters the registry down to active, non-stale (≤90 s) nodes with that block;
`matchGridNode()` picks the best one for the worker's requirements.

## 2. Dispatch protocol (GRID-1)

The grid agent is a small controller base `/api/v1/grid`, served **only by a
core whose node role is `edge`** (`_streamhub_meta.node_role`, set by
`POST /cluster/join-master` or seeded from `STREAMHUB_NODE_ROLE=edge`). On a
`master` or `standalone` core every `/grid/*` route answers `404` exactly like an
unmounted route (3.3.3). Every route is authenticated **manually** (constant-time,
no bearer token, no tenant scope) against **this node's own secret** (3.3.4+:
`HMAC(cluster token, "node:"+nodeId)`, vended by the join and stored by
`join-master`, or `STREAMHUB_NODE_SECRET`): the origin signs each call with the
target node's `X-Node-Secret` and never sends the shared token. While
`STREAMHUB_CLUSTER_LEGACY_TOKEN` is on, a node that still has
`STREAMHUB_CLUSTER_TOKEN` set also accepts it in `X-Cluster-Token` (a pre-3.3.4
origin). A pre-3.3.4 grid agent answers the new origin `401` → local fallback.

| Route | Body / Params | Returns |
|---|---|---|
| `POST /grid/workers` | `{ pluginId, appName, config?{}, ingestToken? }` — `command` / `args` / `env` / `cwd` are rejected (`400 property … should not exist`) | `{ data: { id, status, pid, pluginId, appName, ... } }` |
| `GET /grid/workers/:id/status` | — | `{ data: GridWorkerView }` (404 if unknown) |
| `POST /grid/workers/:id/stop` | — | `{ data: GridWorkerView }` (404 if unknown) |
| `GET /grid/workers/:id/logs?limit=` | — | `{ data: WorkerLogLine[] }` |

Failures: **404** on a non-edge node; **400** on a bad body (incl. a resolved
spec), an invalid `appName`, a plugin that is not `placement:'grid'` on this node,
or a `config` that fails the node's `configSchema`; **404** `plugin '<id>' not
found` when the node's registry lacks it; **503** when `STREAMHUB_CLUSTER_TOKEN`
is unset on the node, **401** on a wrong/absent header.

**The body names the worker; the node resolves the spec.** The origin sends the
plugin id, the app, the install's validated config and the per-start ingest
token. The node looks the plugin up in **its own** registry (built-in or vendored
`streamhub.app.json`), re-validates the config against its schema and runs the
same spawn builder / declarative template as a local spawn, against the REMOTE
ctx (`ctx.node` = this node, `ctx.originUrl` = its master URL — see §4); `cwd` is
the node's own `workerDir`. Until 3.3.3 the origin POSTed the resolved
`command` / `args` / `env`, which let anyone holding the cluster token run
arbitrary commands on every node. On success the origin records the **lease**
(`nodeId`, `remoteId`) on the `WorkerState` and does **not** spawn locally;
`stop()` proxies to the node's `/stop` route (GRID-2 lite).

The agent supervises the process with the **same** machinery as a local plugin
worker: `PluginWorkerManager.startSpec()` reuses the exact spawn / stdout-stderr
ring-buffer / exit-crash lifecycle, keyed by the opaque `remoteId`.

### Safety / fall-back

`dispatch()` **never throws**. A missing/unusable node url (only `http(s)` is
accepted — SSRF guard), an unset cluster token, a non-2xx, a missing worker id,
or a timeout (8 s) all yield `{ dispatched:false, reason }`, and the manager
falls back to a local spawn (`WorkerState.placement` reports the EFFECTIVE
placement: `'grid'` only when actually dispatched, else `'local'`).

## 3. Making a worker grid-capable

Declare `placement:'grid'` + the node requirements in the plugin's
`worker` descriptor. The shipped reference is **yolo** (cleanest offload — HLS
URL in, HTTP callback out):

```ts
// yolo's meta (streamhub.app.json in the streamhub-app-yolo repo; shown in the TS meta notation)
worker: {
  placement: 'grid',
  grid: { gpu: true, capabilities: ['cuda', 'yolo'] },
  spawn(ctx) { /* … returns { command, args, env } … */ },
}
```

`grid` requirements (all optional; empty = "any grid node"):
`gpu`, `minVramGb`, `capabilities[]` (hard filters) and `regions[]` (soft
preference). A node matches only if it advertises **every** required capability.

## 4. Result feed-back (GRID-3)

A local worker gets `STREAMHUB_INGEST_URL=http://127.0.0.1:<port>/…` — unreachable
from another host. For a **remote** dispatch the node's agent instead:

- passes `ctx.originUrl` (the node's **master URL**, `_streamhub_meta.master_url`)
  and `ctx.node` into the spawn builder, and
- injects `STREAMHUB_INGEST_URL = <masterUrl>/api/v1/apps/:app/plugins/:id/live`
  plus the per-start `STREAMHUB_INGEST_TOKEN` (from the dispatch body) into the
  worker env.

So deface / transcription workers POST their results to the origin's public
ingest endpoint (same token check, TLS via Caddy). yolo uses an arbitrary
operator-set `callbackUrl`, so it needs no ingest env at all. If
`PUBLIC_BASE_URL` is unset the worker is still dispatched (fine for yolo) but the
feed-back env is omitted — **the node needs its master URL (set by
`join-master` or `STREAMHUB_MASTER_URL`) for grid feed-back to work.**

## 5. Running a GPU node

1. **Join the node** to the cluster the normal way
   ([INSTALL-NODE.md](../operations/INSTALL-NODE.md)); it self-registers and the
   installer ships the 60 s heartbeat timer. The node's **core** must run with
   role `edge` (`POST /cluster/join-master`, or `STREAMHUB_NODE_ROLE=edge` +
   `STREAMHUB_MASTER_URL` on first boot) — otherwise `/grid/*` is `404` and the
   origin falls back to a local spawn.
2. **Advertise the GPU.** The installer's heartbeat script auto-detects a GPU via
   `nvidia-smi` and adds a `grid` block to the stats it POSTs, e.g.:

   ```json
   { "stats": { "cores": 8, "cpu": 0.06,
                "grid": { "gpu": true, "vramGb": 22,
                          "gpuName": "NVIDIA A10G",
                          "capabilities": ["cuda", "yolo"] } } }
   ```

   No GPU (no `nvidia-smi`) → **no** `grid` block, and the node is never
   grid-selected. Capabilities default to `cuda,yolo`; override the workload tags
   with `STREAMHUB_HB_GRID_CAPS` (comma-separated) in
   `/etc/streamhub/heartbeat.env`, e.g. `STREAMHUB_HB_GRID_CAPS=cuda,yolo,whisper`.

3. **Have the app present.** The node resolves the spawn from its own registry,
   so the app's package (e.g. the vendored `yolo` `streamhub.app.json` + worker)
   must be installed on the node's core, with the same id and a `configSchema`
   that accepts the origin's config. Paths come from the node's own template
   (`workerDir`, `env.*`), not from the origin.

4. **Verify.** Enable the `yolo` plugin on an app; the origin logs
   `grid dispatch OK → node '<name>' worker '<id>'`, and the worker's
   detections arrive at the plugin's `callbackUrl`. `GET
   /grid/workers/:id/status` on the node (with `X-Node-Secret`) shows it
   running.

## 6. Testing with a real remote GPU node

```bash
# On the GPU node (GPU + worker package; NODE_SECRET = its secret from the join / heartbeatEnv):
#   join it, then confirm the heartbeat advertises the grid block:
curl -s -H "Authorization: Bearer $SK_GLOBAL" \
  https://<origin>/api/v1/cluster/nodes | jq '.data[] | {name, stats: .stats.grid}'

# From ANY host, hit the node's grid agent directly (what the origin does):
curl -s -X POST https://<gpu-node>/api/v1/grid/workers \
  -H 'Content-Type: application/json' \
  -H "X-Node-Secret: $NODE_SECRET" \
  -d '{"pluginId":"yolo","appName":"live",
       "config":{"room":"main","callbackUrl":"https://example.com/hooks/yolo"}}'
#   → { "data": { "id": "<remoteId>", "status": "running", ... } }

curl -s https://<gpu-node>/api/v1/grid/workers/<remoteId>/status \
  -H "X-Node-Secret: $NODE_SECRET"
curl -s -X POST https://<gpu-node>/api/v1/grid/workers/<remoteId>/stop \
  -H "X-Node-Secret: $NODE_SECRET"

# End to end via the origin: enable yolo on an app with placement:'grid'
# (default for yolo). With a grid node registered the origin dispatches; with
# none, it spawns locally — same result, so it's safe either way.
```

## 7. Security & limitations

- **Trust boundary.** Since 3.3.3 `POST /grid/workers` can only start a worker of
  a `placement:'grid'` plugin already installed in the node's registry, with a
  config its schema accepts — the caller picks *which* worker, never the command.
  It still trusts the shared `STREAMHUB_CLUSTER_TOKEN` to prove the caller is the
  origin, and only an `edge` core serves it. Keep the token secret and serve the
  node over TLS. (A per-node credential — `nodeSecret = HMAC(clusterToken,
  nodeId)` — is planned for 3.3.4.)
- **`config` is sent to the node.** The install's config (incl. `secret` fields)
  travels in the dispatch body — audit before making a plugin with secrets
  grid-capable.
- **Filesystem parity.** No shared filesystem is assumed; the worker must reach
  its inputs over the network (HLS URL) and push outputs over HTTP. Paths come
  from the node's own template (`workerDir`, `dataDir`, `apps/<app>`).
- **Lite lifecycle (GRID-2).** `stop()` is proxied; `status()` returns the
  origin's cached lease state (`node` + `remoteId` + `placement:'grid'`) — a live
  status refresh from the node (`remoteStatus()`) exists but is not yet polled.
  No automatic re-dispatch on node loss; the worker is restarted on the next
  enable/config change.
- **Not wired yet (GRID-4):** an `/api/v1/grid/*` origin-side management surface
  and a console panel to observe nodes / leases.
