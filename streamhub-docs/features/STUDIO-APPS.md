# Studio Apps vs Plugins — taxonomy + export

> **Two different meanings of "app" — read this first.** StreamHub already uses
> **App** for a *tenant app* (`apps/<app>/app.db`, RTMP key, HLS, VOD — see
> [apps-multitenant.md](apps-multitenant.md)). This page is about a **Studio
> App**: a marketplace *extension* with the `kind: 'app'` taxonomy — a full
> application (own storage, worker, full-page UI, export story) that installs
> INTO a tenant app. When this doc says **App** unqualified it means the Studio
> kind; the tenant is always called the **tenant app**. The REST API keeps every
> extension under `/apps/:app/plugins/*` regardless of kind, so "Studio App" is a
> product/UI concept, not a new API surface.

## The taxonomy — Plugin vs App

The plugin framework ([plugins.md](plugins.md)) discovers one meta (a `builtins.json` entry or a
`streamhub.app.json` package) per extension. A single field splits the catalogue into two:

```ts
export type PluginKind = 'plugin' | 'app';   // default 'plugin'
```

- **`plugin`** — a simple, in-process extension: a player overlay, a swappable
  player provider, a small panel. No persistent state of its own, opens in a
  **modal**, ships only inside StreamHub.
- **`app`** — a full **Studio App**: it owns persistent state and/or a worker
  and/or an app-sized primary UI, opens as a **full page**, and (when
  worker-backed) has a **standalone export** story.

**Decision rule.** `kind: 'app'` = the extension is a *product* — it owns
persistent state and/or a worker and/or an app-sized primary UI, and has a
standalone story. Size of the UI alone does not decide it (the `quality` panel
is a plugin, `cockpit` is an App); a worker alone does not decide it (`fleet`
has no worker and is an App). The field is **additive and optional**: an omitted
`kind` resolves to `'plugin'`, so every pre-existing meta and any third-party
manifest keeps validating unchanged.

## Classification of the 22 built-ins

`Edge` marks an **edge-capable** app — its worker declares `worker.edge: true`
and can be distributed per-stream onto edge nodes (see
[vision-edge.md](vision-edge.md)); it is also the marketplace "Edge-capable"
badge. Every edge-capable built-in is also exportable.

| Extension | id | kind | storage.db | Exportable | Worker | Edge |
|---|---|---|---|:--:|:--:|:--:|
| LPR — License Plate Recognition | `lpr` | **app** | `lpr.db` | ✅ | yes | ● |
| Safety PPE monitor | `safety-ppe` | **app** | `safety-ppe.db` | ✅ | yes | ● |
| Perimeter — intrusion detection | `perimeter` | **app** | `perimeter.db` | ✅ | yes | ● |
| Presence — workstation presence | `presence` | **app** | `presence.db` | ✅ | yes | ● |
| People counter | `people-counter` | **app** | `people-counter.db` | ✅ | yes | ● |
| YOLO object detection | `yolo` | **app** | — | ✅ | yes | ● |
| Deface — face obfuscation | `deface` | **app** | — | ✅ | yes | ● |
| Occupancy — zone dwell & sessions | `occupancy` | **app** | `occupancy.db` | ✅ | yes | ● |
| Counting — line-crossing counter | `counting` | **app** | `counting.db` | ✅ | yes | ● |
| Crowd — density threshold | `crowd` | **app** | `crowd.db` | ✅ | yes | ● |
| Demography — age / gender / emotion | `demography` | **app** | `demography.db` | ✅ | yes | ● |
| VOD Transcription | `transcription` | **app** | — | ✅ | yes | — |
| Fleet — agent management (MQTT) | `fleet` | **app** | `fleet.db` | ✖ | no (in-core module) | — |
| Cameras — OpenCam console (MQTT) | `cameras` | **app** | `cameras.db` | ✖ | no (in-core module) | — |
| Cockpit — CCTV camera wall | `cockpit` | **app** | — | ✖ | no | — |
| Streamflow — workflow engine | `streamflow` | **app** | `streamflow.db` | ✖ | no (in-core module) | — |
| Scheduled Live | `scheduled-live` | plugin | — | ✖ | no | — |
| Quality / Stream Health | `quality` | plugin | — | ✖ | no | — |
| Video Streaming | `streaming` | plugin | — | ✖ | no | — |
| Radio | `radio` | plugin | — | ✖ | no | — |
| Vidstack player provider | `vidstack` | plugin | — | ✖ | no | — |
| Timestamp CCTV | `timestamp` | plugin | — | ✖ | no | — |
| Watermark | `watermark` | plugin | — | ✖ | no | — |

**16 Apps, 7 plugins.** The four vision apps (`occupancy` / `counting` / `crowd`
/ `demography`) are the 2.16.0 split of the retired monolithic `vision` app — all
edge-capable, all exportable, all sharing the one repo-root `vision-edge-runtime`
worker package (see [vision-edge.md](vision-edge.md)). Edge-case rulings:

- **cockpit = App** — the canonical example: a camera-wall *application*. No
  worker; its export story (a standalone web bundle against the REST API) is
  **phase 2**, so it is `exportable: false` today.
- **fleet = App**, `needsWorker: false` — an always-on in-core MQTT subscriber +
  `fleet.db` + OTA, not a spawned worker (see [fleet.md](fleet.md)). That is an
  implementation choice, not a taxonomy signal; not exportable v1.
- **cameras = App**, `needsWorker: false` — like fleet: an in-core MQTT
  subscriber + command sender over the OpenCam contract (see
  [cameras.md](cameras.md)); it needs a UI→device command channel, which a
  decoupled app does not have.
- **streamflow = App**, `needsWorker: false` — an in-core event-workflow engine
  with its own `streamflow.db`; no distributable worker, so not edge-capable and
  not exportable. Its **execution boxes** (`action.code|shell|ssh|db`) run on
  the host, so since 3.3.3 they are an **operator** decision, not a tenant
  setting: the old `dangerousNodes` config key is gone (a PATCH carrying it is
  ignored) and they are enabled per app only by
  `STREAMHUB_STREAMFLOW_DANGEROUS=<app1,app2|*>` (default empty = off). Saving
  a workflow that holds one (create, import/duplicate, graph update, re-enable)
  needs that allowlist (`400` otherwise) **and** a superadmin caller (`403`
  otherwise); the palette lists them only to a superadmin in an allowed app,
  and the runner re-checks the allowlist on every run. At boot, enabled
  workflows with execution boxes in a non-allowed app are disabled with a
  `disabledReason` and a `streamflow.workflow_quarantined` audit event
  (idempotent).
- **transcription = App**, exportable since 1.0.1 (`export.workerDir:
  'transcription-worker'`): the standalone bundle carries the worker, which
  consumes the same file-based job plane (`TRANSCRIBE_JOBS_DIR`: `jobs/` →
  `results/`). Its Studio page is a panel of recent VODs with transcript status,
  SRT download and (re-)transcribe. It is **not edge-capable** (file-based VOD
  jobs are not portable per-stream); an HTTP job plane is still phase 2.
- **the four vision apps = Apps** — first-class Studio Apps carved out of the old
  `vision` plugin; each owns its `<model>.db` and is both exportable and
  edge-capable. They share ONE worker package (`export.workerDir:
  'vision-edge-runtime'`, invoked `--model <id>`).
- **yolo / deface = App** — real-time CV engines, exportable + edge-capable.
  They declare no `storage.db` in v1 (a detections DB for YOLO is a follow-up).
- **scheduled-live = plugin** despite its per-app `scheduled_events` table — it
  is a player overlay with agenda-sized persistence, not an application.
- **streaming / radio = plugin** — thin wrappers over existing endpoints
  (`streaming` already escapes to the full-page `/broadcast/:app`; that stays).

### Manifest projection

`ToManifest(meta)` (in `streamhub-core-go/internal/plugins/contract.go`) adds these serialized fields the
REST marketplace returns:

| Manifest field | Value |
|---|---|
| `kind` | `meta.kind ?? 'plugin'` |
| `storage` | `{ db }` when the meta declares one, else `null` |
| `exportable` | `!!meta.export?.workerDir` (an export descriptor naming a worker dir) |
| `edge` | `meta.worker?.edge === true` — the app's worker can run distributed per-stream on edge nodes (drives the "Edge-capable" badge + gates `POST /apps/:app/edge/assignments`); always `false` for worker-less extensions. See [vision-edge.md](vision-edge.md). |

The registry **validates** the taxonomy at discovery, exactly like every other
field — a malformed one skips the plugin with a logged reason, never a crash:

- `kind` must be `'plugin'` or `'app'` if present;
- `export` is only valid on `kind: 'app'` (an `export` on a plugin is rejected);
- `storage.db` (and `export.workerDir`) must be a **bare filename / directory**
  — a path separator or `..` is rejected.

`storage` is **informational metadata** — it documents the file an App owns and
drives the export/docs; it does **not** relocate or open any database. (Note:
`people-counter.db`, `safety-ppe.db` and their evidence dirs currently live at
the `DATA_DIR` root rather than under `apps/<app>/`; the manifest still
describes them, and relocating those two is a separate follow-up migration.)

## Full-page App view

Apps open as a **full page** inside the tenant app; plugins keep the modal.

- Route: `apps/:app/studio/:pluginId` → `pages/StudioAppPage.tsx` (under the
  `AppLayout` shell).
- Page = a header (icon, name, version badge, enable/disable toggle) + the
  extension's primary surface rendered **full-bleed** (its `app-tab`/`panel`
  component) + secondary tabs:
  - **Overview** — a short blurb / mini-landing.
  - **Settings** — the generated `ConfigForm` (the same schema-driven form the
    modal used).
  - **Logs** — the worker/plugin log stream.
  - **Export** — a download button, shown **only when the manifest is
    `exportable`**.
- `PluginsTab` routes `onOpen` by kind: `kind === 'app'` navigates to the page,
  a plugin opens the modal (`openTargetFor(view)` in `plugins/state.ts`).
- The **Marketplace** (`/studio`) and the per-app **Studio** tab both split their
  grids into two shelves via `partitionByKind` — **Apps** and **Plugins**
  (i18n keys `shelf.apps` / `shelf.plugins`, EN+ES). Default-kind rows land in
  the Plugins shelf.
- The frontend `PluginModule` may also declare `kind`; on merge the **backend
  manifest wins** (same precedence rule as the version field).

## Export bundle (v1 — worker-backed Apps)

An exportable App can be downloaded as a self-contained tarball that runs on the
operator's **own** infrastructure and talks back to any StreamHub over HTTPS —
the open-source lead-magnet path (revenue is consulting / managed ops, not the
bundle).

```
GET /api/v1/apps/:app/plugins/:id/export      →  application/gzip
                                                 streamhub-app-<id>-<version>.tar.gz
```

Auth = the **same permission tier as plugin config write** (`config:write`);
the operation is audit-logged. Guards:

| Status | When |
|---|---|
| `404` | unknown tenant app, or unknown plugin id |
| `400` | the plugin is not `exportable`, or is not installed in this app |
| `503` | the worker source cannot be located (see resolution order below) |

### Layout

```
<id>/
  worker/            verbatim copy of the repo-root worker package
                     (source + requirements.txt + tests)
  Dockerfile         generated: python:3.11-slim + requirements + `python -m <module>`
  docker-compose.yml generated: one service, build ., env_file .env
  .env.example       every env var worker.spawn() injects, as PLACEHOLDERS
  README.md          generated: what it is, how to run, how it talks back
  LICENSE            the repo LICENSE (best-effort)
```

The tarball is packed by a tiny, dependency-free **deterministic USTAR + gzip**
writer (fixed mtime/uid/gid → byte-identical on repeat exports); no `tar`
dependency and no SQLite involvement — an App's `.db` is never opened
or copied. Build/cache/VCS noise (`__pycache__`, `.venv`, `node_modules`, …),
compiled Python (`*.pyc`), any SQLite file (`*.db`) and any file **> 5 MB**
(model/weights binaries) are excluded so the bundle stays source-only and light.

### How the env list is generated (no per-plugin code)

The exporter derives `.env.example` by **calling the meta's pure
`worker.spawn(ctx)`** with a *synthetic* context (placeholder tenant `myapp`,
placeholder dirs, schema-default config) and reading the returned `env` keys.
Because every meta's `spawn` is a pure function of its context, this needs **no
per-plugin export code** — and no real token, secret or hostname from the live
install is ever embedded:

| Key pattern | Exported value |
|---|---|
| secret-typed / `*secret*`, `*token*`, `*api_key*`, … | **blanked** (`=`) |
| `*_CALLBACK_URL` / `*_CALLBACK_SECRET` | **blanked** — the operator fills their own |
| `*_HLS_DIR` | **blanked** — off-host has no shared HLS disk (fall back to `*_PUBLIC_BASE`) |
| `*_PUBLIC_BASE` | forced to a **placeholder host** (`https://your-streamhub.example.com`) |
| `*_LIVEKIT_URL` | placeholder LiveKit URL, commented as optional |
| non-secret config-derived defaults | **kept** verbatim (e.g. the resolved room/fps) |
| framework identity | `STREAMHUB_APP`, `STREAMHUB_PLUGIN_ID` appended |

A final belt-and-suspenders pass scrubs the live install's real `PUBLIC_BASE_URL`
out of the rendered text in case it leaked through a config value.

### Off-host HLS input

Every vision worker accepts **both** a local `*_HLS_DIR` (the shared HLS disk,
preferred when co-located) and an HTTP `*_PUBLIC_BASE` fallback. The export
leaves `*_HLS_DIR` empty and points `*_PUBLIC_BASE` at the operator's StreamHub
origin **root**; the worker appends `/hls/<app>/<room>/index.m3u8` itself. So a
standalone worker pulls HLS over HTTPS with no shared disk or loopback — it runs
anywhere with network access to the server.

### How a standalone worker talks back — two auth planes

| Plane | Transport | Standalone? |
|---|---|---|
| **Direct signed webhook** | `*_CALLBACK_URL` + `*_CALLBACK_SECRET`, HMAC-SHA256 | **yes** — the standalone path |
| **Framework live/events channel** | `POST :id/live` / `:id/events`, `x-plugin-ingest-token` | **no** — co-located only |

- **Direct signed webhook (standalone).** Set `*_CALLBACK_URL` to your HTTPS
  endpoint and `*_CALLBACK_SECRET` to a shared secret. Every event is POSTed to
  that URL and signed:

  ```
  X-StreamHub-Signature: sha256=<HMAC-SHA256 of the raw request body, hex>
  ```

  Verify it on your side with the same secret before trusting the payload. This
  is exactly the callback plane the co-located worker already uses
  (`internal/callbacks/callbacks.go`; e.g. `perimeter-worker/callback.py`).
- **Framework live/events channel (co-located only).** The framework channel
  (`POST /apps/:app/plugins/:id/live` and `.../events`) authenticates with a
  **per-start `x-plugin-ingest-token`** minted by the worker manager when it
  spawns the worker — there is no such token for a process the framework did not
  start, so this plane applies **only** when the worker runs co-located inside a
  StreamHub install. The generated README documents both planes and states this
  limitation.

## Worker-source resolution (where the bundled code comes from)

The bundled `worker/` is copied from the worker's SOURCE package, resolved in
order (first hit wins):

1. `STREAMHUB_WORKER_SRC_ROOT/<workerDir>` — explicit override (env var);
2. `/opt/worker-src/<workerDir>` — the Docker core image ships **source-only**
   copies of every exportable `*-worker/` here (a cheap `COPY`, no `pip
   install`);
3. the repo-root `<workerDir>` — the dev / bare-node path (as the plugin metas
   resolve their workers today).

If none resolves to a directory the route returns `503` with a hint to set
`STREAMHUB_WORKER_SRC_ROOT`.

## Phase-2 notes (not in v1)

- **Cockpit web-bundle export** — a standalone browser bundle (camera wall)
  built against the REST API; cockpit is `kind: 'app'` today but not exportable.
- **Long-lived scoped ingest tokens** — so a standalone worker could relay
  through the framework live/events channel (not just direct webhooks).
- **Transcription HTTP job plane** — replace the file-based `jobs/` → `results/`
  coupling with an HTTP contract so a standalone transcription worker can run
  on a remote GPU without sharing the jobs directory.
- **Relocating the DATA_DIR-root DBs** — move `people-counter.db` /
  `safety-ppe.db` (+ evidence) under `apps/<app>/` to match lpr/presence/
  perimeter; deferred because it touches production data.

## See also

- [plugins.md](plugins.md) — the plugin framework, contract, workers, live-data
  channel, and the full built-in catalogue.
- [callbacks.md](callbacks.md) — the signed-webhook plane (HMAC, headers, event
  taxonomy) an exported worker POSTs into.
- [apps-multitenant.md](apps-multitenant.md) — the **tenant app** (the other
  meaning of "app").
