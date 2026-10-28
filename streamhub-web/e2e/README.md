# Dashboard e2e suite (Playwright)

Behavioral specs that drive the built SPA served by a locally booted core —
the Go core (`streamhub-core-go`). Redis / LiveKit **services** are not needed (flows that need
them are skipped), but the env vars below are.

## 1. Composed vendor apps (required)

The decoupled Studio Apps (occupancy & co.) are NOT in git: `streamhub-core apps pull`
composes them (needs `STREAMHUB_APPS_TOKEN`) into two gitignored dirs. Both must
exist **before building**, or the occupancy specs (05, 10, 11) fail:

| Dir | Used by |
|---|---|
| `plugins-vendor/<id>/` (repo root) | the core's plugin catalog |
| `streamhub-web/src/plugins-vendor/<id>/` | the SPA's Studio App pages / settings forms (bundled at build time) |

A fresh `git worktree` has neither — run `apps pull` there or copy both dirs from
a composed checkout. The Go core finds the catalog via
`STREAMHUB_PLUGINS_VENDOR_DIR` (or `plugins-vendor/` next to the binary, or
`<repo>/plugins-vendor` in a checkout).

## 2. Build

```bash
cd streamhub-web && npm run build                 # → streamhub-web/dist
cd ../streamhub-core-go && go build -o bin/streamhub ./cmd/streamhub   # Go core
```

## 3. Boot the core on :3216

Common env (every var is required: login 401s without the JWT secret, token
minting fails without LiveKit creds, 03-ingress needs passthrough on):

```bash
export PORT=3216 HOST=127.0.0.1 DATA_DIR=/tmp/sh-e2e \
  STREAMHUB_JWT_SECRET=devsecretdevsecretdevsecret \
  ADMIN_USER=admin ADMIN_PASS=admin123 \
  LIVEKIT_URL=ws://127.0.0.1:7880 LIVEKIT_API_KEY=devkey \
  LIVEKIT_API_SECRET=devsecretdevsecretdevsecretdev \
  REDIS_URL=redis://127.0.0.1:6399 NODE_ENV=production \
  STREAMHUB_RTMP_PASSTHROUGH_ENABLE=on
mkdir -p $DATA_DIR
```

The core serves the SPA from `WEB_DIR`:

```bash
cd $DATA_DIR && \
  WEB_DIR=<repo>/streamhub-web/dist \
  STREAMHUB_PLUGINS_VENDOR_DIR=<repo>/plugins-vendor \
  <repo>/streamhub-core-go/bin/streamhub
```

## 4. Seed the token 07-tokens revokes (after the core is up)

```bash
DATA_DIR=$DATA_DIR streamhub-core-go/bin/streamhub \
  seed-token sk_e2e_disposable_xxxxxxxxxxxx e2e-disposable
```

## 5. Run

```bash
cd streamhub-web && npx playwright install chromium   # once per Playwright bump
npm run test:e2e                                      # E2E_BASE_URL overrides the origin
```

Then stop the core and delete `$DATA_DIR`. Expected: all green, with one skip
(regular transcoded ingress — needs the LiveKit ingress service).
