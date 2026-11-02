# Developing your own Studio App / plugin (incl. edge workers)

A hands-on tutorial for building a StreamHub extension. The plugin framework
**auto-discovers** on both sides — there is no central registry to edit, so you
just drop files in and rebuild. This page is the how-to; the reference material
lives in [features/plugins.md](../features/plugins.md) (framework + built-in
catalogue) and [features/STUDIO-APPS.md](../features/STUDIO-APPS.md) (the
`plugin` vs `app` taxonomy + the export bundle). Read those for the *why*; read
this for the *do*.

> **Two meanings of "app".** A **tenant app** is `apps/<app>/` (RTMP key, HLS,
> VOD). A **Studio App** is a marketplace *extension* with `kind: 'app'` that
> installs INTO a tenant app. This page means the Studio kind; the REST surface
> is `/apps/:app/plugins/:id/*` for every extension regardless of kind.

---

## 1. The two halves of an extension

| Half | File | Owned by | Discovered by |
|---|---|---|---|
| **Backend** | built-in: an entry in `streamhub-core-go/internal/plugins/builtin/builtins.json`; decoupled: a `streamhub.app.json` package | the framework (config, lifecycle, worker, events) | embedded catalog + `plugins-vendor/` scan (`internal/plugins` registry) |
| **Frontend** | `streamhub-web/src/plugins/<id>/index.ts(x)` | the dashboard (which UI to render) | Vite `import.meta.glob('./*/index.{ts,tsx}')` — **one level deep** |

Either half can exist alone: a backend-only plugin still renders a generic card +
config form; a frontend-only plugin renders in standalone dev mode. When both
declare a field (e.g. `kind`, `version`) the **backend manifest wins**.

The backend half is a declarative `PluginMeta`. Since 3.2 (the NestJS core's
retirement) a built-in is a JSON object in `builtins.json` — same fields as the
TypeScript below, minus the `worker.spawn` closure, which becomes
`"worker": {"spawn": "<key>"}` naming a Go func in `internal/plugins/builtin.go`
(see that dir's README). The TS form below (`plugin.contract.ts`, branch
`legacy/node-2.x`) is kept because it documents every field with its type.

---

## 2. Anatomy of `plugin.meta.ts`

A built-in plugin is nothing but a `PluginMeta` object default-exported through
`definePlugin({...})` (which just returns it, for type inference). Minimal:

```ts
// streamhub-core/src/plugins/hello/plugin.meta.ts
import { definePlugin } from '../../modules/plugins/plugin.contract';

export default definePlugin({
  id: 'hello',                 // stable slug == folder name
  name: 'Hello Panel',
  description: 'A tiny demo panel.',
  category: 'panel',           // 'tool' | 'processor' | 'panel'
  ui: 'app-tab',               // 'app-tab' | 'panel' | 'player-overlay' | 'player'
  version: '1.0.0',            // REQUIRED semver
  configSchema: [
    { key: 'greeting', type: 'string', label: 'Greeting', default: 'hi' },
  ],
});
```

The fields that carry the weight:

### `kind` — plugin vs Studio App

```ts
kind?: 'plugin' | 'app'   // default 'plugin'
```

- **`plugin`** — a simple in-process extension (overlay, panel, player provider).
  Opens in a **modal**; ships only inside StreamHub.
- **`app`** — a full **Studio App**: owns persistent state and/or a worker and/or
  an app-sized primary UI; opens as a **full page** (`apps/:app/studio/:id`) and
  (when worker-backed) has a standalone **export** story.

The decision rule and the classification of all 22 built-ins are in
[STUDIO-APPS.md](../features/STUDIO-APPS.md#the-taxonomy--plugin-vs-app).

### `configSchema` — every field needs a default

Typed fields (`string | number | boolean | select | secret`) rendered by the
framework as a generic form. **Every field MUST declare a `default`** so an
install with no config is immediately valid (`secret` defaults to `''`). Mark a
field `required: true` to block *enabling* the install until it is non-empty:

```ts
configSchema: [
  { key: 'room', type: 'string', label: 'Room / stream', default: '', required: true,
    placeholder: 'gate-cam', help: 'HLS room to analyze — /hls/<app>/<room>/index.m3u8.' },
  { key: 'fps', type: 'number', label: 'Sample FPS', default: 2, min: 1, max: 30 },
  { key: 'detector', type: 'select', label: 'Model', default: 'small',
    options: [{ value: 'small', label: 'Small (fast)' }, { value: 'large', label: 'Large' }] },
]
```

### `events` — the domain-event allowlist

If your worker emits domain events, **declare their names**. Only declared names
are accepted by the event channel and dispatched through the app's signed
callbacks (webhook + MQTT); an undeclared name is rejected, so a worker can never
spoof core events (`vod_ready`, …):

```ts
events: ['plate.detected', 'plate.allowed', 'plate.denied'],
```

### `storage` — the SQLite file the App owns

Informational metadata (drives the export bundle + docs; does **not** relocate
anything). Must be a **bare filename** — a path separator or `..` is rejected:

```ts
storage: { db: 'lpr.db' },
```

### `needsWorker` + `worker.spawn(ctx)` — a pure spawn spec

Set `needsWorker: true` and give a `worker` descriptor whose `spawn` is a **pure
function** of its context returning exactly what the core will
`child_process.spawn` — `{ command, args, env, cwd }`. The plugin says *what* to
run; the **framework owns the lifecycle** (start/stop/status/logs). This is the
pattern every shipped Python-worker app follows — the six with their own
repo-root `<id>-worker/` (yolo, transcription, safety-ppe, perimeter, presence,
people-counter) plus the four vision apps (occupancy, counting, crowd,
demography), which share the one `vision-edge-runtime/` package; the decoupled
`lpr` and `deface` carry the same worker pattern in their own repos:

```ts
worker: {
  spawn(ctx) {
    const dir = workerDir();               // repo-root <id>-worker, or the env override (§6)
    return {
      command: process.env.PLUGIN_PYTHON ?? 'python3',
      args: ['-m', 'lpr_worker', '--app', ctx.app],
      cwd: dir,
      env: {
        PYTHONPATH: dir,
        PYTHONUNBUFFERED: '1',
        LPR_ROOM: String(ctx.config.room ?? ''),
        LPR_FPS: String(ctx.config.fps ?? 2),
        LPR_DATA_DIR: path.join(ctx.appDir, 'lpr'),   // per-app SQLite + snapshots
        LPR_CALLBACK_URL: String(ctx.config.callbackUrl ?? ''),
      },
    };
  },
  edge: true,   // optional — see §8
},
```

`spawn` receives a read-only `PluginWorkerContext`: `app`, validated `config`
(defaults filled), `appDir` (abs path to `apps/<app>/`), `dataDir` (abs
`DATA_DIR`), `livekitUrl`, and — only on remote dispatch — `node` + `originUrl`.
Keep `spawn` **side-effect free**: the exporter calls it with a synthetic context
to derive the standalone bundle's `.env.example` (§7), so any I/O there would run
at export time.

---

## 3. The frontend `PluginModule`

Drop `streamhub-web/src/plugins/<id>/index.tsx` default-exporting a
`PluginModule` (via `definePlugin` for inference). The glob picks it up with zero
edits to any shared file:

```tsx
// streamhub-web/src/plugins/hello/index.tsx
import { definePlugin } from '../types'

function HelloTab({ ctx }: { ctx: { app?: string; config: Record<string, unknown> } }) {
  return <div>Hello {String(ctx.config.greeting ?? 'there')} from {ctx.app}</div>
}

export default definePlugin({
  id: 'hello',
  name: 'Hello Panel',
  ui: 'app-tab',                 // renders TabComponent
  TabComponent: HelloTab,
})
```

The component you supply depends on `ui`: `TabComponent` (`app-tab`),
`PanelComponent` (`panel`), `OverlayComponent` (`player-overlay`),
`PlayerComponent` (`player` — a swappable HLS/VOD media player). Provide a
`configSchema` for the generic form, or a `ConfigComponent` to replace it. Full
prop contracts are in `streamhub-web/src/plugins/types.ts`. Registry logic lives
in `registry.ts` (kept separate from the Vite glob so it stays unit-testable
under `node:test`).

---

## 4. Writing the Python worker

The shipped workers all follow the same shape, and yours should too:

1. **Input — HLS in.** Pull the app's live stream. Prefer the on-disk HLS dir
   when co-located, fall back to the public URL
   (`<PUBLIC_BASE>/hls/<app>/<room>/index.m3u8`). Accepting both is what lets the
   exact same worker run co-located *or* on a remote edge node with no shared disk.
2. **Process** — run your model / logic per sampled frame.
3. **Output — HTTP events out.** POST domain events to the framework event
   channel; the framework relays them through the app's signed callbacks. When
   exported/standalone, POST directly to a signed webhook instead.
4. **State — your own SQLite** under the per-app data dir you were handed in
   `env` (e.g. `LPR_DATA_DIR = apps/<app>/lpr/`), plus evidence JPEGs/clips.

### Framework env every worker receives

The worker manager merges these over your `spec.env` when it spawns a co-located
worker (they are absent for a standalone/exported run — which is why standalone
uses the direct signed webhook instead):

| Env var | What it is |
|---|---|
| `STREAMHUB_INGEST_URL` | `POST` target for live-data updates → `GET :id/data` (dashboard tab) |
| `STREAMHUB_EVENTS_URL` | `POST` target for declared domain events → signed callbacks |
| `STREAMHUB_INGEST_TOKEN` | per-start bearer echoed as `x-plugin-ingest-token` on both channels |

Study `lpr-worker/` or `perimeter-worker/` as the reference implementations; each
has a `callback.py` for the direct signed-webhook plane
(`X-StreamHub-Signature: sha256=<HMAC-SHA256 of the raw body>`).

### Tests — pure logic, no heavy deps

Every worker ships `pytest` tests that exercise **logic only** — zones,
dedupe, schedule, sqlite, config, the callback contract — with **no** torch /
opencv / onnxruntime imported. That keeps the suite runnable in CI without a GPU
or model weights:

```bash
cd lpr-worker && pytest       # plates/dedupe/sqlite/config/loop logic, no fast-alpr
```

---

## 5. The lifecycle the framework owns

Because `spawn` is a pure spec, the core drives the process for you. You never
touch `child_process`:

| Action | REST | Dashboard |
|---|---|---|
| install / configure | `POST :id/install`, `PATCH :id` | Studio App page → Settings |
| (re)start worker | `POST :id/worker/start` — also triggered by enabling | enable toggle |
| stop worker | `POST :id/worker/stop` — also on disable | disable toggle |
| status | `GET :id/worker/status` | header badge |
| logs | `GET :id/logs` | Logs tab |

Enabling an install (re)starts the worker; disabling stops it. That intent is
**persisted** (the `worker_desired` column), so your worker is resumed
automatically after a core restart / deploy — you don't need a re-toggle. See
[plugins.md §Workers](../features/plugins.md#workers) and
[Workers survive a core restart](../features/plugins.md#workers-survive-a-core-restart).

---

## 6. The dev loop — four options that exist today

**(a) Edit in-tree + rebuild the image.** The canonical path. Drop your
`plugin.meta.ts` (and frontend `index.tsx`) under `src/plugins/<id>/`, put the
Python package at repo-root `<id>-worker/`, and rebuild the core image
(`docker compose up -d --build`, or `streamhub upgrade` on a managed box). SPA +
backend + worker all ship in that one image.

**(b) Point a *running* worker at a host directory.** Each worker meta resolves
its package via its **own** `<ID>_WORKER_DIR` env var (falling back to repo-root
`<id>-worker`), and the interpreter via `PLUGIN_PYTHON`. Set those to iterate on
worker code without rebuilding the JS:

```bash
# on the host, in the core service env:
PLUGIN_PYTHON=/opt/workers/venv/bin/python
LPR_WORKER_DIR=/srv/dev/lpr-worker        # DEFACE_WORKER_DIR, YOLO_WORKER_DIR, PRESENCE_WORKER_DIR,
                                          # PERIMETER_WORKER_DIR, SAFETY_PPE_WORKER_DIR,
                                          # TRANSCRIPTION_WORKER_DIR, PEOPLE_COUNTER_WORKER_DIR
```

> **Not to be confused with `STREAMHUB_WORKER_SRC_ROOT`.** That variable feeds the
> **export** source resolver (§7) — where the tarball's worker copy is read from —
> **not** the running worker's spawn dir. To relocate a *running* worker you use
> its per-plugin `<ID>_WORKER_DIR`, as above.

**(c) Export the bundle and run it standalone.** For an exportable App, download
the self-contained tarball and run it on your own box against any StreamHub over
HTTPS — the fastest way to iterate on the worker in isolation (§7).

**(d) Version it in the appstore + pin per app — the export → modify → push →
pin → rollback cycle.** The master keeps an **immutable version store** per
plugin at `DATA_DIR/appstore/<id>/<version>/` (`bundle.tar.gz` + a manifest with
a server-computed sha256; built-ins materialize at boot as `builtin-<coreVersion>`).
The `streamhub app` subcommand — run on the **origin/master**, authed with the
`STREAMHUB_API_TOKEN` from `.env` — drives the whole cycle **without a rebuild**:

```bash
# 1. get the exact streamhub-app export layout to base a change on: export the
#    installed App (GET …/plugins/:id/export) OR pull an already-stored version
#    (pull verifies the sha256 locally and fails loudly on a mismatch):
streamhub app versions lpr                       # inspect the catalog; note the builtin id
streamhub app pull lpr builtin-2.19.0 -o lpr.tar.gz

# 2. modify the worker source inside lpr/worker/… and repack the .tar.gz.

# 3. push it as a NEW immutable version — never overwrites; a dupe semver is a
#    409, so you always bump. Prints the manifest (sha256 + size):
streamhub app push lpr.tar.gz --plugin lpr --version 2.19.1 --notes 'faster OCR'

# 4. pin that version for ONE tenant app (restarts a live worker onto the
#    sha256-verified, lazily-extracted bundle):
streamhub app pin lpr 2.19.1 --app acme
streamhub app versions lpr --app acme            # shows the ACTIVE marker + pin history

# 5. roll back instantly if it misbehaves (repins to the version the app ran
#    before its last change) — or clear the pin to run the built-in/latest again:
streamhub app rollback lpr --app acme
streamhub app unpin lpr --app acme
```

Retire an unused version with `streamhub app delete-version <id> <version>`
(refused while any app pins it — unpin first — and for a built-in). This is the
same store the edge cluster fetches pinned bundles from over the shared
`X-Cluster-Token`, so a per-app pin is what a remote node ends up running too.
Full command reference: `streamhub app help`.

---

## 7. Export bundles (worker-backed Apps)

An App becomes **exportable** by declaring an `export.workerDir` (a bare
repo-root worker dir), valid only on `kind: 'app'`:

```ts
kind: 'app',
storage: { db: 'lpr.db' },
export: { workerDir: 'lpr-worker' },
```

Then:

```
GET /api/v1/apps/:app/plugins/:id/export   →  application/gzip
                                              streamhub-app-<id>-<version>.tar.gz
```

Inside: `worker/` (verbatim source copy), a generated `Dockerfile`
(`python:3.11-slim` + requirements + `python -m <module>`), `docker-compose.yml`,
`.env.example` (**derived by calling your pure `spawn(ctx)`** with a synthetic
context — secrets blanked, hostnames forced to placeholders), `README.md`, and
`LICENSE`. The worker source is resolved in order:
`STREAMHUB_WORKER_SRC_ROOT/<dir>` → `/opt/worker-src/<dir>` (the image ships
source-only copies here) → repo-root `<dir>` (dev). The full contract — env
scrubbing rules, the two talk-back auth planes, guards (`400`/`404`/`503`) — is in
[STUDIO-APPS.md §Export bundle](../features/STUDIO-APPS.md#export-bundle-v1--worker-backed-apps).

---

## 8. The edge angle

A worker can opt into being **distributed per-stream** onto registered edge nodes
by declaring `worker.edge: true`. That flag:

- badges the App **"Edge-capable"** in the marketplace, and
- gates the app-scoped edge-assignments API
  (`POST /apps/:app/edge/assignments { pluginId, streamId }` accepts only
  `edge: true` plugins).

The spawn stays the **same pure function** — the generic edge spawn resolver calls
it with a *remote* context (`originUrl` set, no shared-disk `*_HLS_DIR`) exactly
like the grid path, which is why a worker that already reads HLS over HTTP and
POSTs signed events "just works" remotely; the framework injects
`STREAMHUB_EVENTS_URL` + a stable, scoped ingest token, and your own secrets stay
on the master. `EdgeReconcileService` then mirrors the app's active streams onto
assignments — one per `(plugin × stream)` — whenever an edge node is connected.
An **edge node** is a StreamHub install with `--node-type edge`: it joins the
master, runs **no public media plane**, dials the master's control WebSocket
**outbound** (NAT-friendly, no inbound port), and supervises one worker per
`(app × plugin × stream)` assignment. The canonical reference — control channel,
scheduler, reconcile, the `vision-edge-runtime`, node retype
(`PATCH /edge/nodes/:id`) — is [features/vision-edge.md](../features/vision-edge.md).

Distinct from `edge`, `worker.placement: 'grid'` requests a single BYO-GPU node
for the worker's one app-wide run; until the remote scheduler ships it falls back
to a local spawn, so declaring it is always safe. See
[plugins.md §Worker placement](../features/plugins.md#worker-placement-grid--optional-defaults-to-local).

---

## 9. The package manifest — `streamhub.app.json` (decoupled apps)

Everything above describes a **built-in**: a `plugin.meta.ts` compiled into the
core image. The [app-decoupling work](../../planning/APP-DECOUPLING-PLAN.md)
lets an app live in its **own repo** and be **composed into the build** from a
package tarball. A package cannot ship a `plugin.meta.ts` — the core would have
to `require()` downloaded JavaScript, which is exactly the supply-chain hole we
refuse. Instead a package ships a **declarative** `streamhub.app.json`: the same
information as a meta, but as DATA the core interprets, never code it runs.

Schema (for editor/CI validation):
[`streamhub.app.schema.json`](./streamhub.app.schema.json). Runtime validation
+ the meta projection live in `streamhub-core-go/internal/plugins/appmanifest.go`;
the spawn interpreter in `spawntemplate.go`. The on-the-wire bundle contract
(tar.gz layout, sha256 pinning, lock sources, the app-repo release) has its own
reference: [PACKAGE-FORMAT.md](./PACKAGE-FORMAT.md).

`lpr` is the live pilot of a **fully** decoupled app: it lives in its own repo
(`gitlab:digitalhub_com_ar/streamhub-app-lpr`), releases from its own CI, and is
composed into this repo from a pinned `gitlab:` release — no `lpr` source remains
in-tree. The rest of this section documents both the manifest (any decoupled app)
and the two composing flows: the in-tree authoring flow (an app not yet moved
out) and the own-repo flow (like `lpr`).

### Layout of a package

```
streamhub.app.json     the manifest (below)
worker/                the Python worker package (source + requirements.txt)
frontend/              the web PluginModule source (index.tsx, …)
migrations/            NNN_*.sql the worker applies on boot (see below)
```

### The manifest

Identity/`configSchema`/`events`/`storage`/`ui`/`kind` are **identical** to
`plugin.meta.ts`. The one real difference is the worker: instead of a
`spawn(ctx)` closure, you declare a pure **spawn template**.

```jsonc
{
  "manifestVersion": 1,
  "id": "lpr", "name": "…", "description": "…",
  "category": "processor", "ui": "app-tab", "kind": "app", "version": "0.1.0",
  "compat": { "core": ">=2.19 <3" },
  "storage": { "db": "lpr.db" },
  "events": ["plate.detected", "plate.allowed", "plate.denied"],
  "configSchema": [ /* … same shape as a meta … */ ],
  "worker": {
    "needsWorker": true,
    "entry": "{{pluginPython}} -m lpr_worker --app {{app}}",
    "cwd": "{{workerDir}}",
    "placement": "grid", "grid": { "capabilities": ["lpr"] }, "edge": true,
    "env": {
      "PYTHONPATH": "{{workerDir}}",
      "LPR_ROOM": "{{config.room}}",
      "LPR_DEVICE": "{{ config.cuda | ternary:cuda:cpu }}",
      "LPR_DATA_DIR": "{{appDir}}/lpr",
      "LPR_PUBLIC_BASE": "{{publicBase}}"
    }
  },
  "frontend": { "dir": "frontend", "mode": "composed" },
  "migrations": { "dir": "migrations", "db": "lpr.db" }
}
```

### Spawn-template grammar

`entry` is **tokenized on whitespace BEFORE substitution**, so a substituted
value (e.g. `{{app}}`) can never split into an extra argument. `cwd` and every
`env` value are rendered. Inside `{{ … }}`:

| Form | Meaning |
|---|---|
| `{{app}}` `{{appDir}}` `{{dataDir}}` `{{livekitUrl}}` `{{originUrl}}` `{{publicBase}}` `{{workerDir}}` `{{pluginPython}}` | context / framework refs |
| `{{config.<key>}}` | one config value, stringified like `String(v)` (`true`/`false`, numbers, `''` when absent) |
| `{{configJson}}` | the whole config as compact JSON |
| `{{env.NAME}}` | a process-env var (the worker inherits process env anyway) |
| `{{ a ?? b ?? 'lit' }}` | coalesce — first non-empty wins |
| `{{ ref \| ternary:then:else }}` | `then` when truthy (not `''`/`false`/`0`), else `else` |
| `{{ ref \| map:k=v,k=v,*=default }}` | table lookup with a `*` default |

Text outside `{{ }}` is literal, so `"{{appDir}}/lpr"` works. This grammar is
**non-Turing-complete on purpose** — enough to reproduce the real workers
byte-for-byte without ever evaluating package-supplied logic. the `internal/plugins` spawn-template tests
proves it two ways: `presence` (in-tree) asserts the interpreted spec `deepEqual`s
its code meta's `spawn(ctx)` — the living witness; `lpr` (its code meta removed in
the exodus) is locked to a GOLDEN spec loaded from the vendored manifest, and
skips when `lpr` isn't composed.

### Migrations — updates never lose worker data

The worker owns its SQLite under `appDir/<id>/`; the app package never touches
it. To evolve its schema across versions, ship ordered `migrations/NNN_*.sql` and
apply them on boot:

```python
from streamhub_sdk.migrations import apply_migrations
apply_migrations(db_path, migrations_dir)   # idempotent; PRAGMA user_version
```

The runner (`streamhub-app-sdk/streamhub_sdk/migrations.py`) is idempotent,
transactional (a failed migration rolls back whole), backs up (`VACUUM INTO`)
before touching an existing db, and **refuses a downgrade** (a `user_version`
newer than the migrations on disk) rather than corrupt a schema.

### Building & composing a package

Two flows produce the same bundle contract (full reference:
[PACKAGE-FORMAT.md](./PACKAGE-FORMAT.md)); both end in a `sha256`-pinned entry in
`apps.lock.json` that `streamhub-core apps pull` composes into the build.

**Own repo (like `lpr`).** The app lives in its own repo with its own CI. On a
tag `v<version>` the CI builds the deterministic bundle and publishes it +
a `.sha256` as GitLab Release assets. The monorepo pins a `gitlab:` source:

```bash
# apps.lock.json (committed):
#   [{ "id":"lpr", "repo":"gitlab:digitalhub_com_ar/streamhub-app-lpr",
#      "version":"0.1.0", "sha256":"…" }]

# compose it — resolves the release, verifies sha256, fails closed on mismatch.
# The GitLab token is read from the ENV only (never the lock/logs); a private
# source with no token fails closed.
# (from a checkout: cd streamhub-core-go && go run ./cmd/streamhub apps …)
STREAMHUB_APPS_TOKEN=<token> streamhub-core apps pull            # → vendor/apps/<id>/ + plugins-vendor/<id>/
STREAMHUB_APPS_TOKEN=<token> streamhub-core apps bump [--write]  # newest stable release; --write updates the lock
```

The `core-go` CI job runs `apps pull` as a lock gate **only when
`STREAMHUB_APPS_TOKEN` is set** (a masked + protected CI variable), so the unit
suites stay hermetic. Specs that assert a decoupled app skip when it isn't
composed (see [UNIT-TESTS.md](../testing/UNIT-TESTS.md)).

**Packing locally.** `apps pack` builds the bundle from explicit sources (what an
app repo's CI runs); `--worker-sdk` vendors a shared Python SDK dir INTO the worker
as `worker/<name>/`, `--migrations` adds `migrations/`. Pack to a local tarball
and pin a `file:` source to try it in a composed build:

```bash
streamhub-core apps pack --manifest streamhub.app.json --worker worker --frontend frontend --out dist
# → dist/streamhub-app-<id>-<v>.tar.gz + .sha256 (content hash)
# pin { id, version, sha256, source: "file:./…" } in apps.lock.json, then apps pull.
```

`apps pull` links the backend manifest into the repo-root `plugins-vendor/<id>/`
(scanned by the registry after the built-ins) and the frontend into
`streamhub-web/src/plugins-vendor/<id>/` (globbed by `discovery.ts`). Both
`-vendor` dirs are **gitignored + regenerated**. On an id that ALSO exists
in-tree, **the in-tree copy wins** and the vendored one is skipped with a warning
(so composing a package next to a shipped app never silently shadows it).

---

## See also

- [features/plugins.md](../features/plugins.md) — framework, contract, workers,
  live-data channel, full built-in catalogue.
- [features/STUDIO-APPS.md](../features/STUDIO-APPS.md) — taxonomy + export bundle.
- [features/vision-edge.md](../features/vision-edge.md) — the CV edge cluster.
- [testing/UNIT-TESTS.md](../testing/UNIT-TESTS.md) — the suite catalogue; add
  yours next to the code (spec-next-to-code, no infra).
- [operations/MANUAL-BUILD-INSTALL.md](../operations/MANUAL-BUILD-INSTALL.md) —
  how the image is built (where your `src/plugins/<id>` and `<id>-worker/` land).
- [streamhub.app.schema.json](./streamhub.app.schema.json) — the package manifest
  schema; `../../planning/APP-DECOUPLING-PLAN.md` — the full decoupling plan;
  `../../streamhub-app-sdk/` — the Python SDK (migrations runner).
</content>
