# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**StreamHub** — a self-hosted media server built as a management layer over a LiveKit SFU (drop-in-style alternative to AntMedia): multi-tenant apps, RTMP/WHIP/RTSP ingest, WebRTC + HLS playback, recording to per-app S3, signed webhooks, REST API, React dashboard — all behind one domain with auto-TLS.

**Naming:** product = StreamHub; repo = `vision-media-server`. Docs and commit messages are mixed Spanish/English.

## Components (each with its own package.json)

| Path | Stack | Role |
|---|---|---|
| `streamhub-core/` | NestJS, TS strict, better-sqlite3, BullMQ | REST API `/api/v1` + serves the SPA, HLS, SDK; binds `127.0.0.1:3020` |
| `streamhub-web/` | React 19 + Vite + Tailwind 4 | dashboard SPA, built into the core image |
| `streamhub-adaptor/` | TS + tsup | browser SDK: AntMedia `WebRTCAdaptor` shim over `livekit-client`, served at `/sdk/` |
| `yolo-worker/` | Python (ultralytics + opencv) | worker process spawned by the `yolo` plugin |
| `deploy/` | Dockerfile, Caddyfile, entrypoint, `seed-token.js`, systemd/nginx units | both deploy shapes |
| `streamhub-docs/` | Markdown | full docs: architecture, operations, API reference, testing catalogue |
| `legacy/` | — | retired code kept only for reference (original Express LiveKit admin UI, old static player pages) — never build or deploy from here |

## Commands

### streamhub-core (run from `streamhub-core/`)

```bash
npm run build            # nest build
npm run start:dev        # watch mode
npm test                 # jest: unit (*.spec.ts next to code) + e2e (test/*.e2e-spec.ts)
npx jest src/modules/auth/auth.service.spec.ts   # single suite
npm run test:e2e         # e2e only
npm run lint             # eslint --fix
```

Tests need **no infrastructure**: `bullmq`/`ioredis` are hard-mapped to in-memory fakes in `test/helpers/mocks/`, LiveKit/S3 are mocked per-suite (factories in `test/helpers/`), env defaults come from `test/helpers/env.ts`. Keep it that way — a spec that dials Redis or the network is a bug.

### streamhub-web (run from `streamhub-web/`)

```bash
npm run dev              # vite; proxies /api to the live prod core (see vite.config.ts)
npm run build            # tsc -b && vite build
npm test                 # node --test over src/{plugins,lib}/**/*.spec.ts (TS via node type-stripping)
node --test src/plugins/registry.spec.ts          # single test
npm run lint             # oxlint
```

### streamhub-adaptor / yolo-worker

```bash
cd streamhub-adaptor && npm run build      # tsup → dist/*.global.js ; npm run typecheck
cd yolo-worker && pytest                   # pure-logic tests, no torch/opencv needed
```

### Full stack (Linux host only — LiveKit uses host networking)

```bash
docker compose up -d --build
docker compose exec -T core node deploy/seed-token.js "$(grep '^STREAMHUB_API_TOKEN=' .env | cut -d= -f2)"
curl http://127.0.0.1:3020/api/v1/health   # health; Swagger at /api/v1/docs
```

`install.sh` is the one-liner installer (secrets → build → up → seed). All config is a single `.env` (`.env.example` is fully commented; every var in `streamhub-docs/operations/ENV.md`).

## Architecture

**Request routing (single domain):** Caddy (or nginx) terminates TLS; `/rtc` → LiveKit signaling :7880; everything else (`/`, `/api/v1`, `/hls`, `/sdk`, `/samples`, `/metrics`) → core :3020. WebRTC media (7882/udp), RTMP (1935) and WHIP (8080) hit the server IP directly. Compose services: `redis`, `livekit`, `ingress`, `egress`, `core`, `caddy`.

**One core image serves everything:** the multi-stage `deploy/Dockerfile` builds the web SPA → copied to `./web` (ServeStaticModule), the adaptor IIFE → copied into `<DATA_DIR>/sdk` at boot by the entrypoint, and the compiled NestJS core. So SPA changes ship by rebuilding the **core** image.

**Data — per-app SQLite:** minimal global `data/streamhub.db` (tenants, users, api_tokens, nodes registry, apps pointer) + one `apps/<app>/app.db` per app owning app-scoped state (streams, vods, ingress_auth). A global→per-app split migration runs idempotently at boot after a `VACUUM INTO` backup. `DATA_DIR` also holds recordings/HLS/snapshots and is bind-mounted into **both** core and egress — egress writes MP4s exactly where core looks to upload them to the app's S3 bucket (per-app S3 creds live in `data/secrets.json`, referenced from the app's `config.yaml`).

**Auth planes:** `sk_` bearer tokens for the REST API (global + per-app, seeded via `deploy/seed-token.js`); JWT dashboard login with break-glass `ADMIN_USER`/`ADMIN_PASS`; a public play-token for anonymous playback. RBAC (casbin) + quotas roll out via `STREAMHUB_AUTHZ_ENFORCE=off|log|on`.

**Plugin framework — auto-discovery on both sides, no central registry to edit:**
- Backend: drop `streamhub-core/src/plugins/<id>/plugin.meta.ts` default-exporting `definePlugin({...})` (contract: `src/modules/plugins/plugin.contract.ts` — the ONE file plugin authors import). Categories `tool|processor|panel`, UI slots `app-tab|panel|player-overlay`, typed `configSchema` where **every field needs a default**. `needsWorker: true` + a pure `worker.spawn(ctx)` returning `{command, args, env}` makes the framework own the process lifecycle (start/stop/status/logs) — the `yolo` plugin spawns `python -m yolo_worker` this way.
- Frontend: drop `streamhub-web/src/plugins/<id>/index.ts(x)` default-exporting a `PluginModule`; `discovery.ts` picks it up via `import.meta.glob` (one level deep only). Registry logic stays in `registry.ts` so it's testable under node:test.

**Core code ownership convention** (from `streamhub-core/README.md`): `src/main.ts`, `src/app.module.ts`, `src/shared/**` (config, db, auth guard, cross-module contracts) are scaffolder-owned — don't edit them when working inside a feature module; features live in `src/modules/<name>/`.

## Key docs

- `ARCHITECTURE.md` — top-level map; full diagrams in `streamhub-docs/architecture/`
- `streamhub-docs/api/README.md` — every route + permission; `api-global.md` / `api-app.md`
- `streamhub-docs/config-reference.md` — per-app `config.yaml` incl. `features:` block
- `streamhub-docs/testing/UNIT-TESTS.md` — catalogue of every suite and the invariants it locks down; update it when adding suites
- `streamhub-docs/operations/` — DEPLOY, RUNBOOK, ENV, OBSERVABILITY
- `streamhub-docs/SPEC.md` — product spec
