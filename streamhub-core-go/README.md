# streamhub-core-go — the StreamHub core

**The shipped core since 3.x.** It replaced the NestJS core (2.x), which was removed from
`main` and lives on in branch `legacy/node-2.x` (tag `2.24.0`); its HTTP behaviour survives as
the recorded parity oracle (`test/parity/golden/`). Plan/history:
internal design notes; deliberate deviations from Node: internal design notes.
Contract: **identical** to the 2.x core — same `/api/v1` routes and JSON, same `.env`, same
`DATA_DIR` layout and SQLite schema — so the SPA, MCP server, browser SDK, the Python apps and
2.x installs work unchanged.

```bash
go build -o bin/streamhub ./cmd/streamhub     # binary
go test ./...                                  # tests (no network, no Redis, no LiveKit)
go vet ./...
go run ./cmd/parity -go ./bin/streamhub        # parity replay vs the recorded oracle (test/parity/README.md)
DATA_DIR=/tmp/sh WEB_DIR=../streamhub-web/dist ./bin/streamhub
```

## Shipping

| Shape | Built by | Layout |
|---|---|---|
| Docker image (`core` service) | `deploy/Dockerfile` (`golang:1.26-alpine`, `CGO_ENABLED=0 -trimpath`, `go generate ./internal/buildinfo` to embed `CHANGELOG.md`, then `-ldflags -X …/internal/platform/version.{Override,Commit,BuildDate}` — commit from the `STREAMHUB_GIT_COMMIT` build arg, the context has no `.git`) | `/app/streamhub-core` (+ `/usr/local/bin/streamhub-core`), `/app/web`, `/app/plugins-vendor`, `/app/adaptor-dist` |
| Plain server (systemd) | `deploy/make-core-bundle.sh` → `streamhub-core-<ver>-linux-<arch>.tar.gz` (same generate + ldflags; commit from `git rev-parse HEAD`), installed by `deploy/deploy-core.sh` | `<APP_DIR>/streamhub-core`, `web/`, `plugins-vendor/`, `adaptor-dist/`, `VERSION` |

Runtime lookups (all overridable): SPA `WEB_DIR` › `<exe dir>/web` › `./web`; SDK `SDK_DIR` ›
`<DATA_DIR>/sdk`; vendored apps `STREAMHUB_PLUGINS_VENDOR_DIR` › `<exe dir>/plugins-vendor` ›
(repo checkout) `<repo>/plugins-vendor`; version: ldflags › `VERSION` in the
cwd / next to the binary (or one level up) › `dev`; changelog (`GET /system/changelog`): embedded
copy › `CHANGELOG.md` looked up like `VERSION` › none. **Embedding the changelog:** `go:embed`
can't reach outside the module, so `go generate ./internal/buildinfo` copies the repo-root
`CHANGELOG.md` into `internal/buildinfo/changelog/` (gitignored) — run it before a release build;
a plain `go build` still compiles (a committed placeholder keeps the embed pattern matching). External tools: `ffmpeg`/`ffprobe` (media),
`PLUGIN_PYTHON` (decoupled-app workers). No Node at runtime: the stream-health worker is the
binary's own `health-worker` subcommand (`internal/healthworker`).

Operator subcommands (no argument = serve):

```bash
streamhub-core seed-token <sk_token|-> [name]   # idempotent global token seed (DATA_DIR env, default /data)
streamhub-core healthcheck                      # exit 0 iff 127.0.0.1:$PORT/api/v1/health is 200
streamhub-core version
streamhub-core apps pull|pack|bump              # decoupled-apps tooling (internal/appstool; was scripts/apps-*.mjs)
streamhub-core health-worker                    # the stream-health worker (spawned per app by the plugin framework)
streamhub-core opsfmt <view> [args] < resp.json # render a /api/v1 response for deploy/streamhub (internal/opsfmt; was python3 -c)
```

## Layout

| Path | Role |
|---|---|
| `cmd/streamhub` | boot: config → logger → DB → planes (`*plane.go`, provide/need wiring) → HTTP server, graceful shutdown; operator subcommands |
| `cmd/parity` | parity harness: replay vs the recorded oracle; record/live against a `legacy/node-2.x` build (`test/parity/`) |
| `cmd/streamhub-mcp` | MCP stdio server for AI clients (`internal/mcpserver`; also `streamhub-core mcp`) — `https://streamhub.studio/docs/integrations/MCP` |
| `test/healthworker-parity` | runs the 2.x Node stream-health worker and `streamhub-core health-worker` over the same ffmpeg-made HLS rooms and diffs their event sequences |
| `internal/platform/config` | `.env` → `Config` (1:1 with `shared/config/config.service.ts`) |
| `internal/platform/db` | global + per-app SQLite, migrations exported verbatim from `migrations.ts` |
| `internal/platform/httpx` | error shapes (Nest + envelope), client IP, middleware |
| `internal/platform/api` | huma API, `Module` contract, `Public()`, global auth guard |
| `internal/platform/web` | `/hls`, `/samples`, `/sdk`, SPA fallback |
| `internal/server` | wiring (Go counterpart of `app.module.ts` + `bootstrap()`) |
| `internal/<module>` | one package per Node module (`src/modules/<module>` at `legacy/node-2.x`) |
| `internal/plugins/builtin/builtins.json` | the built-in plugin metas — source of truth (its README) |

## Conventions (how the modules were ported — still the rules for any contract change)

The Node sources referenced below exist only in branch `legacy/node-2.x` (tag `2.24.0`).

1. **Read the Node module first** (`streamhub-core/src/modules/<m>` at the tag): controller, service, DTOs,
   its `*.spec.ts` and its entry in `https://streamhub.studio/docs/testing/UNIT-TESTS`. The spec invariants are
   the requirements.
2. **One package per module**, `internal/<m>`. A `Module` struct built by `New(deps…)` with a
   `Register(huma.API)` method; business logic in plain methods (testable without HTTP). Split
   god-services by responsibility (e.g. `apps` → config / secrets / lifecycle / s3).
3. **Routes**: full path with `api.Prefix`, same method, same path params, same `operationId` as
   `streamhub-docs/api/openapi.json`. `@Public()` → `api.Public(op)`; otherwise the global guard
   applies. Authorization (casbin) and quotas are explicit calls in the handler.
4. **JSON parity is the contract.** Same field names (camelCase vs snake_case exactly as Node
   returns them), `null` vs absent exactly as Node, timestamps as Node formats them (SQLite
   `datetime('now')` strings stay strings; JS `toISOString()` → `2006-01-02T15:04:05.000Z` UTC).
   Return enveloped bodies only where Node does.
5. **Errors**: `httpx.NotFound/BadRequest/...` reproduce Nest's `{statusCode,message,error}` with
   the **same message text** as the Node exception. Use `httpx.Enveloped` only where Node writes the
   `{data:null,error:{code,message}}` envelope.
6. **SQL**: plain `database/sql` with `?` params against `db.Service.Global/App`. Module-owned
   tables (Node `CREATE TABLE IF NOT EXISTS` inside a service/store) keep that exact DDL, run once
   per handle from the module.
7. **No blocking the world**: every request runs in its own goroutine, so blocking I/O is fine, but
   long jobs (ffmpeg, uploads, VACUUM, tar) run in background goroutines with a context, never in
   the request when Node didn't block it.
8. **Timers** (`setInterval` in Node) → a goroutine with `time.Ticker` started by `Start(ctx)` and
   stopped by context cancel; same intervals.
9. **Tests**: table-driven `_test.go` next to the code porting every invariant of the Node spec.
   No network: fakes behind small interfaces (LiveKit, S3, Redis, SMTP). Cross-runtime vectors
   (hashes, signatures, ciphertexts) were generated by the Node code into `testdata/`; they are
   frozen now — their generators are marked HISTORICAL and need a `legacy/node-2.x` checkout.
10. **Done** = `go vet` + `go test` green, routes match `openapi.json`, parity replay green.
    A deliberate deviation is logged in internal design notes and re-baselined with
    `cmd/parity -accept`.
