# Contributing to StreamHub

Thanks for your interest in improving StreamHub! Pull requests are welcome — bug fixes,
docs, tests, and features.

## Ground rules

- Open an issue first for anything non-trivial so we can align on approach.
- Keep changes focused; one logical change per PR.
- Add or update tests for behavior changes. Every component's tests run without external
  infrastructure (Redis, LiveKit, S3, SMTP and network sit behind small interfaces with
  fakes) — please keep it that way: a test that dials the network is a bug.
- The REST contract is pinned: same routes, operationIds, JSON, status codes and error
  texts. The parity replay (`streamhub-core-go/cmd/parity`, see
  [`test/parity/README.md`](streamhub-core-go/test/parity/README.md)) must stay green.
- Describe user-visible behavior changes in the PR so the published docs
  ([streamhub.studio/docs](https://streamhub.studio/docs)) can be updated. The unit-test catalogue is at
  [testing/UNIT-TESTS](https://streamhub.studio/docs/testing/UNIT-TESTS).
- Never commit secrets (`.env`, `data/secrets.json`, `sk_`/`clt_`/`wsk_` tokens, S3 keys).
- Security issues: do **not** open a public issue — see [`SECURITY.md`](SECURITY.md).

## Repository layout

See [`ARCHITECTURE.md`](ARCHITECTURE.md), [`streamhub-core-go/README.md`](streamhub-core-go/README.md)
and the [architecture docs](https://streamhub.studio/docs/architecture/README) for the full map.

| Path | Stack | Role |
|---|---|---|
| `streamhub-core-go/` | Go (one static binary, pure-Go SQLite) | the core: REST API `/api/v1`, serves the SPA, HLS, SDK; also the MCP server (`cmd/streamhub-mcp`) |
| `streamhub-web/` | React 19 + Vite + Tailwind | dashboard SPA (built into the core image) |
| `streamhub-adaptor/` | TypeScript + tsup | browser SDK (`WebRTCAdaptor` shim over `livekit-client`) |
| `plugins-vendor/`, `streamhub-web/src/plugins-vendor/` | Python + TS | the worker-backed Studio Apps (pre-composed) |
| `deploy/` | Docker/Caddy/nginx/systemd | both deploy shapes |

## Development commands

### streamhub-core-go (run from `streamhub-core-go/`)

```bash
go build -o bin/streamhub ./cmd/streamhub   # the binary (shipped as `streamhub-core`)
go test ./...                               # unit + integration, no infrastructure needed
go vet ./... && gofmt -l .
DATA_DIR=/tmp/sh WEB_DIR=../streamhub-web/dist ./bin/streamhub   # run it
go run ./cmd/parity -go ./bin/streamhub     # parity replay against the recorded contract
go build -o bin/streamhub-mcp ./cmd/streamhub-mcp                # MCP stdio server
```

### streamhub-web (run from `streamhub-web/`)

```bash
npm run dev              # vite dev server
npm run build            # tsc -b && vite build
npm test                 # node --test over src/{plugins,lib}/**/*.spec.ts
npm run lint             # oxlint
```

### streamhub-adaptor

```bash
cd streamhub-adaptor && npm run build      # tsup → dist/*.global.js ; npm run typecheck ; npm test
```

## Running the full stack

The full stack (LiveKit + core + ingress + egress + redis + Caddy) targets a **Linux host**
because LiveKit uses host networking for media. See
[operations/DEPLOY](https://streamhub.studio/docs/operations/DEPLOY) and
[`INSTALL.md`](INSTALL.md).

```bash
docker compose up -d --build
grep '^STREAMHUB_API_TOKEN=' .env | cut -d= -f2 | docker compose exec -T core streamhub-core seed-token - bootstrap
curl http://127.0.0.1:3020/api/v1/health   # Swagger at /api/v1/docs
```

## Plugins

StreamHub auto-discovers plugins on both sides — no central registry to edit. Backend: the
built-in metas are declarative JSON (`streamhub-core-go/internal/plugins/builtin/builtins.json`),
and every `streamhub.app.json` package under `plugins-vendor/` is picked up at boot. Frontend:
drop `streamhub-web/src/plugins/<id>/index.ts(x)`. See
[features/plugins](https://streamhub.studio/docs/features/plugins) and
[development/PACKAGE-FORMAT](https://streamhub.studio/docs/development/PACKAGE-FORMAT).

## License

By contributing, you agree that your contributions are licensed under **AGPL-3.0-only**, the
same license as the project (see [`LICENSE`](LICENSE)).
