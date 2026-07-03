# Contributing to StreamHub

Thanks for your interest in improving StreamHub! Pull requests are welcome — bug fixes,
docs, tests, and features.

## Ground rules

- Open an issue first for anything non-trivial so we can align on approach.
- Keep changes focused; one logical change per PR.
- Add or update tests for behavior changes. Every component's tests run without external
  infrastructure (Redis, LiveKit, S3 and network are mocked) — please keep it that way.
- Update the relevant docs under [`streamhub-docs/`](streamhub-docs/) when you change
  behavior. The unit-test catalogue lives in
  [`streamhub-docs/testing/UNIT-TESTS.md`](streamhub-docs/testing/UNIT-TESTS.md).
- Never commit secrets (`.env`, `data/secrets.json`, `sk_`/`clt_`/`wsk_` tokens, S3 keys).
- Security issues: do **not** open a public issue — see [`SECURITY.md`](SECURITY.md).

## Repository layout

See [`CLAUDE.md`](CLAUDE.md) and [`ARCHITECTURE.md`](ARCHITECTURE.md) for the full map. Each
component has its own `package.json`:

| Path | Stack | Role |
|---|---|---|
| `streamhub-core/` | NestJS + TypeScript | REST API `/api/v1`, serves the SPA, HLS, SDK |
| `streamhub-web/` | React 19 + Vite + Tailwind | dashboard SPA (built into the core image) |
| `streamhub-adaptor/` | TypeScript + tsup | browser SDK (`WebRTCAdaptor` shim over `livekit-client`) |
| `yolo-worker/` | Python | worker process spawned by the `yolo` plugin |
| `deploy/` | Docker/Caddy/nginx/systemd | both deploy shapes |

## Development commands

### streamhub-core (run from `streamhub-core/`)

```bash
npm run build            # nest build
npm run start:dev        # watch mode
npm test                 # jest: unit (*.spec.ts) + e2e (test/*.e2e-spec.ts)
npm run test:e2e         # e2e only
npm run lint             # eslint --fix
```

### streamhub-web (run from `streamhub-web/`)

```bash
npm run dev              # vite dev server
npm run build            # tsc -b && vite build
npm test                 # node --test over src/{plugins,lib}/**/*.spec.ts
npm run lint             # oxlint
```

### streamhub-adaptor / yolo-worker

```bash
cd streamhub-adaptor && npm run build      # tsup → dist/*.global.js ; npm run typecheck
cd yolo-worker && pytest                   # pure-logic tests, no torch/opencv needed
```

## Running the full stack

The full stack (LiveKit + core + ingress + egress + redis + Caddy) targets a **Linux host**
because LiveKit uses host networking for media. See
[`streamhub-docs/operations/DEPLOY.md`](streamhub-docs/operations/DEPLOY.md) and
[`INSTALL.md`](INSTALL.md).

```bash
docker compose up -d --build
curl http://127.0.0.1:3020/api/v1/health   # Swagger at /api/v1/docs
```

## Plugins

StreamHub auto-discovers plugins on both sides — no central registry to edit. Backend:
drop `streamhub-core/src/plugins/<id>/plugin.meta.ts`. Frontend: drop
`streamhub-web/src/plugins/<id>/index.ts(x)`. See `CLAUDE.md` for the contract.

## License

By contributing, you agree that your contributions are licensed under **AGPL-3.0-only**, the
same license as the project (see [`LICENSE`](LICENSE)).
