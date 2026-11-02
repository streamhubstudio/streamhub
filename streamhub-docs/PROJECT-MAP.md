# StreamHub — Project Map

Orientation for anyone landing in `vision-media-server` for the first time: where
everything lives, what version each piece is pinned to, and how to author your
first plugin. Everything here is verified against the tree as of product
**VERSION `2.11.0`** (repo-root `VERSION`).

> **Product vs package versions.** The repo-root `VERSION` file (currently
> `2.11.0`) is the **product** version — what a release/tag is cut against. Each
> component's own `package.json` `version` is independent and mostly a
> placeholder (`0.1.0` / `0.0.0`); don't read meaning into it.

> **Since this snapshot (2.11.0 → 2.23.0): the app-decoupling program.** The
> `*-worker/` directories this map originally listed at repo root (`yolo-worker`,
> `deface-worker`, `lpr-worker`, `safety-ppe-worker`, `perimeter-worker`,
> `presence-worker`, `people-counter-worker`, `transcription-worker`) — plus the
> vision Studio Apps (`occupancy`/`counting`/`crowd`/`demography`) and their
> `vision-edge-runtime` — **moved out of this repo** into their own versioned
> repos (`gitlab:digitalhub_com_ar/streamhub-app-<id>`) and are now composed
> into the build at pack time (§1 below reflects this). Dependency/version
> tables in §2 that describe still-in-tree components remain accurate; the
> per-worker tables describe the last in-tree snapshot of code that now lives
> and versions independently in its own repo. See
> `streamhub-docs/development/PACKAGE-FORMAT.md`,
> `streamhub-docs/history/2026-07-13-decoupling-and-feature-waves.md`, and
> `CLAUDE.md`'s component table for the current state.

---

## 1. Project tree

Annotated, one line per entry — key subdirs only, not file-by-file. Every
component below has its own `package.json` or `requirements.txt`.

```
vision-media-server/
├── VERSION                     # product version (2.11.0) — source of truth for releases
├── docker-compose.yml          # full stack: redis, livekit, ingress, egress, core, caddy (+ rtmps profile)
├── install.sh / uninstall.sh   # one-liner installer (secrets → build → up → seed) / reverse
├── CLAUDE.md / ARCHITECTURE.md # repo guide for agents / top-level architecture map
├── README.md / INSTALL.md      # entry docs
│
├── streamhub-core-go/          # THE core (Go): API (/api/v1) + serves SPA/HLS/SDK; binds 127.0.0.1:3020
│   ├── cmd/streamhub/          # main + *plane.go wiring (+ seed-token/healthcheck/version subcommands)
│   ├── cmd/parity/             # parity harness: replays test/parity/cases against the recorded
│   │                           #   NestJS oracle (test/parity/golden) — the legacy core itself lives
│   │                           #   only in branch legacy/node-2.x (tag 2.24.0)
│   └── internal/               # one package per module; platform/ = config, db, httpx, api, validate, …
│       └── plugins/builtin/builtins.json   # the 13 built-in plugin metas (source of truth)
│
├── plugins-vendor/             # composed decoupled apps, backend side (generated; only README.md committed)
│
├── streamhub-web/              # React 19 + Vite + Tailwind 4 dashboard SPA (built into the core image)
│   └── src/
│       ├── pages/ components/ layout/ ui/   # dashboard screens + design system
│       ├── plugins/                # frontend plugin modules: <id>/index.tsx (import.meta.glob)
│       ├── lib/ api/ auth/ theme/ i18n/ locales/
│
├── streamhub-adaptor/         # browser SDK: AntMedia WebRTCAdaptor shim over livekit-client; served at /sdk/
├── apps.lock.json              # decoupled-app pins: {id, repo, version, content-sha256} — see PACKAGE-FORMAT.md
│
│   # ── Decoupled Studio Apps (12) — NOT in this tree; composed at pack time by
│   #    `streamhub-core apps pull` into plugins-vendor/<id>/ (repo root) from
│   #    their own repos (gitlab:digitalhub_com_ar/streamhub-app-<id>), pinned by
│   #    version + content sha256 in apps.lock.json. No repo-root <id>-worker/
│   #    directories exist anymore (yolo/deface/lpr/safety-ppe/perimeter/presence/
│   #    people-counter/transcription each moved to their own repo in 2.20.0; the
│   #    4 vision apps — occupancy/counting/crowd/demography, sharing the
│   #    vision-edge-runtime — moved together into ONE repo, streamhub-app-vision,
│   #    in 2.23.0, releasing 4 bundles per tag). See §1's built-ins table below.
│
├── deploy/                    # Dockerfile, Caddyfile(.edge), entrypoint, make-core-bundle.sh + deploy-core.sh, systemd/, nginx-*, rtmps/, observability/
├── examples/                  # runnable client samples (cctv-grid, conference, hls-player, radio, telemedicine, …)
├── streamhub-docs/            # this documentation set (architecture, operations, api, features, testing)
└── planning/                  # internal product & planning notes — PRIVATE working docs, not for publication
```

### `streamhub-core-go/internal/` (feature packages)

One package per feature module of the former NestJS core (same names, without
dashes: `scheduled-live` → `scheduledlive`). Self-describing packages (`auth`,
`authn`, `authz`, `apps`, `streams`, `recording`, `s3`, `quotas`, `security`,
`tenancy`, `email`, `logs`, `audit`, `health`, `metrics`, `backups`, `admin`,
`samples`, `livekit`, `cluster`, `edge`) plus the ones worth naming:

| Module | Role |
|---|---|
| `plugins` | the plugin framework — registry, worker manager, events/live-data channels, export, grid |
| `passthrough` | RTMP/SRT → HLS passthrough (orchestration + auth gate) |
| `pipeline` | resolved ingest pipeline (node kinds / wire shape) |
| `wsingest` | direct WebSocket MJPEG frame ingest + last-frame hub (e.g. ESP32-CAM) |
| `restream` | multi-destination RTMP forwarding (AntMedia "endpoints") |
| `broadcast` | broadcast / RTMP stream egress orchestration |
| `transcoding` | transcoding-focused projection of an app's config |
| `transcription` | VOD transcription jobs (feeds the `transcription` plugin's worker) |
| `scheduledlive` | real-time agenda push over a LiveKit data channel |
| `fleet` | in-core MQTT glue for the `fleet` plugin |
| `mqtt` | MQTT broker/bridge tap for signed callbacks |
| `callbacks` | signed outbound app callbacks (HMAC webhooks) |
| `metricshistory` | in-app host resource-usage history |
| `dbadmin` | per-app SQLite health / optimize / purge |
| `system` | node GPU / hardware-transcode capability detection |

### Built-in plugins — `streamhub-core-go/internal/plugins/builtin/builtins.json`

One declarative meta per **in-tree** plugin, embedded in the binary (the source
of truth since the NestJS core's retirement — edit the JSON; see that dir's
README). `kind: 'app'` = a full Studio App (own page/storage/worker/export); the
rest are simple in-process plugins. None of the worker-backed CV/vision apps
live here anymore (see the decoupled-apps table below) — every in-tree entry
below is either a plain plugin or an in-core app with no external worker
process.

| Plugin | category · ui | kind | worker |
|---|---|---|---|
| `timestamp` | tool · player-overlay | plugin | — |
| `watermark` | tool · player-overlay | plugin | — |
| `scheduled-live` | tool · player-overlay | plugin | — |
| `vidstack` | tool · player | plugin | — |
| `quality` | tool · panel | plugin | — |
| `streaming` | tool · app-tab | plugin | — |
| `radio` | panel · app-tab | plugin | — |
| `live-control-overlay` | tool · player-overlay | plugin | — |
| `cockpit` | panel · panel | app | — |
| `fleet` | tool · app-tab | app | — |
| `live-control` | tool · app-tab | app | — |
| `stream-health` | processor · app-tab | app | — (`streamhub-core health-worker`, framework-spawned) |
| `streamflow` | tool · app-tab | app | — (in-core, no external worker) |

13 in-tree built-ins total (5 Studio Apps + 8 plugins) — matches the count in
the repo-root `CLAUDE.md` component table.

### Decoupled Studio Apps (12 — composed at build time, not in this tree)

Each below is a full Studio App living in its own repo
(`gitlab:digitalhub_com_ar/streamhub-app-<id>`), pinned in `apps.lock.json` by
version + content sha256, and composed into `plugins-vendor/`
by `streamhub-core apps pull` at pack time (indistinguishable from an in-tree
built-in once composed). See
[development/PACKAGE-FORMAT.md](./development/PACKAGE-FORMAT.md).

| App | category · ui | worker | decoupled in |
|---|---|---|---|
| `yolo` | processor · player-overlay | Python (`ultralytics`) | 2.20.0 |
| `deface` | processor · player-overlay | Python (`onnxruntime` CenterFace) | 2.20.0 |
| `lpr` | processor · app-tab | Python (`fast-alpr`) | 2.20.0 |
| `perimeter` | processor · app-tab | Python (`ultralytics`) | 2.20.0 |
| `presence` | processor · app-tab | Python (`ultralytics`) | 2.20.0 |
| `people-counter` | processor · app-tab | Python (`ultralytics` + ByteTrack) | 2.20.0 |
| `safety-ppe` | processor · app-tab | Python (`onnxruntime`, EXPERIMENTAL) | 2.20.0 |
| `transcription` | processor · panel | Python (`faster-whisper`) | 2.20.0 |
| `occupancy` | processor · app-tab | Python (shared `vision-edge-runtime`, `streamhub-app-vision` repo) | 2.23.0 |
| `counting` | processor · app-tab | Python (shared `vision-edge-runtime`, `streamhub-app-vision` repo) | 2.23.0 |
| `crowd` | processor · app-tab | Python (shared `vision-edge-runtime`, `streamhub-app-vision` repo) | 2.23.0 |
| `demography` | processor · app-tab | Python (shared `vision-edge-runtime`, `streamhub-app-vision` repo) | 2.23.0 |

The last 4 release from ONE repo (`streamhub-app-vision`), 4 single-app bundles
per tag, each embedding its own copy of the runtime.

---

## 2. Component & library versions

Runtime baselines from CI (`.gitlab-ci.yml`): **Go 1.26** for the core,
**Node 24** (`node:24`) for every JS/TS component, **Python 3.12** (`python:3.12`) for every worker. Infra image
tags from `docker-compose.yml`.

### streamhub-core-go — the core (Go)

| | |
|---|---|
| Runtime | Go 1.26 · one static binary (`CGO_ENABLED=0`) · License AGPL-3.0-only |
| HTTP | `huma/v2` (OpenAPI 3.1 at `/api/v1/openapi.json`) over `net/http` |
| Data | `modernc.org/sqlite` (pure Go) — same schema as 2.x |
| Test | `go test` (fakes behind interfaces; Node-generated vectors frozen in `testdata/`) + the parity replay |

### streamhub-web — dashboard SPA

| | |
|---|---|
| Runtime | Node ≥ 24 · TypeScript ~6.0.2 · License AGPL-3.0-only |
| UI | React ^19.2.7 · Vite ^8.1.1 · Tailwind 4 (`tailwindcss` / `@tailwindcss/vite` ^4.3.2) |
| LiveKit | `livekit-client` **2.15.7 (pinned)** · `@livekit/components-react` **2.9.15 (pinned)** |
| Players | `@vidstack/react` ^1.15.6 · `video.js` ^8.23.9 · `hls.js` ^1.6.16 |
| Data/routing/i18n | `@tanstack/react-query` ^5.101.2 · `react-router-dom` ^7.18.1 · `i18next` ^26.3.4 |
| Lint/test | `oxlint` ^1.71.0 · `vitest` ^4.1.10 (+ `node --test` for pure logic) |

> **LiveKit pins are load-bearing.** `livekit-client` is pinned to **2.15.7** and
> `@livekit/components-react` to **2.9.15** (with an `overrides` block holding the
> whole tree there) because that is the validated pair against `livekit-server`
> **1.8.4** — 2.20 cannot publish against 1.8.4. Upgrade server + both client libs
> in lockstep. Same pin, same reason, in the adaptor.

### streamhub-adaptor — browser SDK

| | |
|---|---|
| Runtime | Node ≥ 24 · TypeScript ^5.4.0 · License **MIT** (embeddable drop-in) |
| Bundler | `tsup` ^8.0.0 → IIFE/global at `/sdk/` |
| Peer | `livekit-client` ^2.0.0 (dev-pinned + **bundled 2.15.7** in the global build) |

### streamhub-mcp — MCP over stdio (`streamhub-core-go/cmd/streamhub-mcp`)

| | |
|---|---|
| Runtime | Go 1.26 · static binary per platform (`deploy/make-mcp.sh`) · also `streamhub-core mcp` |
| SDK | `github.com/modelcontextprotocol/go-sdk` v1.8.0 |

### Python workers (Python 3.12) — now maintained in each decoupled app's own repo

These libs are no longer repo-root directories here (§1) — each worker now
versions independently in its own `streamhub-app-<id>` repo. Table kept as the
last-verified snapshot of key libs; check each app's own repo for current pins.

| Worker (app) | Key libs |
|---|---|
| `yolo` | `ultralytics` >=8.2,<9 · `opencv-python-headless` >=4.9 (torch/torchvision via ultralytics) |
| `perimeter` | `ultralytics` >=8.2,<9 · `opencv-python-headless` >=4.9 |
| `presence` | `ultralytics` >=8.2,<9 · `opencv-python-headless` >=4.9 |
| `people-counter` | `ultralytics` >=8.2,<9 · `lapx` >=0.5.5 (ByteTrack) · `opencv-python-headless` >=4.9 |
| `deface` | `onnxruntime` >=1.17 · `onnx` >=1.15 · `opencv-python-headless` >=4.9 |
| `safety-ppe` | `onnxruntime` >=1.17 · `opencv-python-headless` >=4.9 (ONNX export, no AGPL ultralytics runtime) |
| `lpr` | `fast-alpr[onnx]` >=0.3 (MIT) · `opencv-python-headless` >=4.9 |
| `transcription` | `faster-whisper` >=1.0 (CTranslate2) |
| `occupancy` / `counting` / `crowd` / `demography` | shared `vision-edge-runtime` (ultralytics YOLO11 + opencv; InsightFace opt-in for demography) — one repo, `streamhub-app-vision` |

All workers keep HTTP + SQLite on the stdlib (no `requests`, no ORM); GPU is an
opt-in swap (e.g. `onnxruntime-gpu`, torch CUDA wheels).

### Infra images (`docker-compose.yml`)

| Service | Image tag |
|---|---|
| LiveKit server | `livekit/livekit-server:v1.8.4` (pinned) |
| LiveKit ingress | `livekit/ingress:latest` |
| LiveKit egress | `livekit/egress:latest` |
| Redis | `redis:7-alpine` |
| Caddy | `caddy:2-alpine` |

> Ingress/egress track `latest`; only the LiveKit **server** is pinned (to the
> 1.8.4 that the client pins are validated against).

---

## 3. Build your first plugin

A plugin plugs in with **zero edits to any central registry** on either side —
auto-discovery does the wiring. Backend and frontend each have a `<id>/` folder;
they share the plugin **id** and the **ui slot**. The backend side is a declarative meta (an
entry in `builtins.json` for a built-in, or a `streamhub.app.json` package for a
decoupled app — [development/PACKAGE-FORMAT.md](./development/PACKAGE-FORMAT.md));
the frontend side imports `streamhub-web/src/plugins/types.ts`. The `timestamp` plugin is the
reference we mirror below; `yolo` (now decoupled into its own repo, see §1) is
the historical reference for the worker shape — the `spawn(ctx)` contract in
the example below is unchanged, it just no longer lives in this repo.

We'll build a trivial `hello` player-overlay: it stores one config field and
draws it on the player. No worker, no storage.

### a. Backend — an entry in `streamhub-core-go/internal/plugins/builtin/builtins.json`

Add one object (keep the array sorted by `id`); the registry embeds and
validates it at build time — nothing else to touch (`TestBuiltinsCatalogIsValid`
fails on an invalid entry).

```jsonc
{
  "id": "hello",                 // stable slug — MUST equal the frontend id
  "name": "Hello Overlay",
  "description": "Draws a fixed greeting on top of the player.",
  "category": "tool",            // tool | processor | panel
  "ui": "player-overlay",        // app-tab | panel | player-overlay | player
  "version": "1.0.0",            // REQUIRED semver (a non-semver value is rejected)
  "configSchema": [
    {
      "key": "greeting",
      "type": "string",          // string | number | boolean | select | secret
      "label": "Greeting text",
      "default": "Hello"         // EVERY field needs a default — an install with no config must be valid
    }
  ]
}
```

A worker plugin also sets `"needsWorker": true` and `"worker": {"spawn": "<key>"}`,
where `<key>` names a Go spawn func in `internal/plugins/builtin.go`. A plugin
that ships outside the core is a decoupled package instead
([development/PACKAGE-FORMAT.md](./development/PACKAGE-FORMAT.md)).

Rules the registry enforces: `version` must be valid semver; every `configSchema`
field needs a `default`; a `secret` field defaults to `''`. This is the
**server-side source of truth** for the config a tenant persists per app.

`kind` defaults to `'plugin'`. Set `kind: 'app'` only for a full **Studio App** —
one that opens as its own full page and owns storage/worker/export (declare
`storage: { db: '<name>.db' }` and, for the export bundle, `export: { workerDir:
'<dir>' }`). See [features/STUDIO-APPS.md](./features/STUDIO-APPS.md). Our `hello`
is a plain plugin, so we leave `kind` off.

### b. Frontend — `streamhub-web/src/plugins/hello/index.tsx`

Default-export a `PluginModule` whose `id` and `ui` match the backend. Discovery
uses `import.meta.glob('./*/index.{ts,tsx}', { eager: true })` — **one level of
sub-folder only**, so `src/plugins/hello/index.tsx` is picked up while the
framework's own flat files (`registry.ts`, `host.tsx`, …) are not. Provide the
component that matches your slot: `TabComponent` (app-tab), `PanelComponent`
(panel), `OverlayComponent` (player-overlay) or `PlayerComponent` (player).

```tsx
import { definePlugin } from '../types.ts';
import type { PluginComponentProps } from '../types.ts';

function HelloOverlay({ ctx }: PluginComponentProps) {
  // ctx.config is the merged config (schema defaults + persisted values).
  const greeting = String(ctx.config.greeting ?? 'Hello');
  return (
    <div className="pointer-events-none absolute bottom-3 left-3 z-20 rounded bg-black/55 px-2 py-1 text-white">
      {greeting}
    </div>
  );
}

export default definePlugin({
  id: 'hello',                 // MUST match the backend meta id
  name: 'Hello Overlay',
  ui: 'player-overlay',        // same slot as the backend
  version: '1.0.0',
  OverlayComponent: HelloOverlay,
  // configSchema is optional on the frontend (the generic ConfigForm is driven
  // by the BACKEND schema); mirror it only if you want defaults before the
  // backend responds. See timestamp/index.tsx for the mirrored-schema pattern.
});
```

The overlay renders only when the plugin is **installed + active** for the app —
the host's `<PluginSlot placement="player-overlay">` decides that from the merged
catalog. Keep the real logic in a pure, framework-agnostic util module and keep
the component a thin shell (that's what the `node:test` specs exercise).

### c. How it connects (lifecycle)

The controller is mounted at `apps/:app/plugins` (per-app, `sk_`-token auth).
Install state lives in the per-app `app_plugins` table (`apps/<app>/app.db`),
row = `plugin_id, enabled, config_json, installed_at`.

| Step | Call | Effect |
|---|---|---|
| Install | `POST /apps/:app/plugins/:id/install` | inserts the `app_plugins` row |
| Configure / enable | `PATCH /apps/:app/plugins/:id` | validates config against `configSchema`, sets `enabled` |
| Uninstall | `DELETE /apps/:app/plugins/:id` | removes the row |
| Logs | `GET /apps/:app/plugins/:id/logs` | worker/plugin log tail |

**Worker plugins** (`needsWorker: true` + a `worker.spawn(ctx)`): the framework
owns start/stop/status/logs (`POST :id/worker/start` · `stop` · `GET
:id/worker/status`). `spawn` is a **pure** function of `PluginWorkerContext` (app,
validated `config`, `appDir`, `dataDir`, `livekitUrl`) returning
`{ command, args, env, cwd }` — the core never learns what the worker *is*
(Python, Node, a binary). This is the shape an **in-tree** plugin's
`worker.spawn()` function returns (e.g. `stream-health`'s Node worker today);
`yolo` used to be the canonical illustration of it before it was decoupled
into its own repo:

```ts
worker: {
  spawn(ctx) {
    return {
      command: process.env.PLUGIN_PYTHON ?? 'python3',
      args: ['-m', 'yolo_worker', '--app', ctx.app],
      cwd: workerDir(),                          // an in-tree app's own <id>-worker/
      env: { PYTHONPATH: workerDir(), YOLO_APP: ctx.app, /* …resolved config… */ },
    };
  },
  // Optional: placement: 'grid' + grid: { gpu: true, … } requests a remote
  // BYO-GPU node; falls back to a local spawn until the grid scheduler ships.
}
```

A **decoupled/composed** app (§1) doesn't ship a `spawn()` function at all —
its `streamhub.app.json` declares the same shape **declaratively** as a
spawn-template (placeholders like `{{pluginPython}}`, `{{app}}`) that
`spawn-template.ts` interprets at run time. No `eval`, no downloaded code
executed by the core; only the app's own Python worker subprocess runs.

**Emitting events.** A worker pushes domain events to `POST
/apps/:app/plugins/:id/events` (ingest-token auth — the worker-hook injects
`STREAMHUB_EVENTS_URL` / `STREAMHUB_INGEST_TOKEN`). Only names in the meta's
`events: [...]` allowlist are accepted — every accepted event is dispatched
through the app's **signed callbacks** (webhook + MQTT tap) under that exact name.
Undeclared names are rejected, so a worker can't spoof core events. Example: `lpr`
declares `['plate.detected','plate.allowed','plate.denied']`.

**Live-data channel.** For UI that needs the worker's latest results, the worker
`POST`s to `:id/live` and the dashboard reads `GET :id/live` (the app-tab pulls
via the authenticated live channel). Workers that feed results back into the main
feed publish LiveKit data messages on topic `plugin:<id>` so player overlays can
subscribe by id.

Depth beyond this quickstart: [features/plugins.md](./features/plugins.md) (the
framework in full), [features/STUDIO-APPS.md](./features/STUDIO-APPS.md) (the
`app` kind, storage, export), [features/players.md](./features/players.md) (the
`player` slot), [features/NEXTGEN-ADDONS.md](./features/NEXTGEN-ADDONS.md) and
[features/GRID.md](./features/GRID.md) (grid placement + the feed-back topic).
