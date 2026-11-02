# Stabilization backlog

Living list of correctness/robustness issues surfaced by empirical testing (AWS rounds,
installer/upgrade validation, API-first audit). Fix-forward; each item is reproducible.
Newest batch: **2026-07-05**.

## Open — cluster / media plane

- **[Fixed — installer] Cluster join default URL is unreachable.** `--join --origin-ip <ip>`
  targeted `http://<ip>:3020`, but core binds `127.0.0.1:3020` (only nginx on `:80`). Now the
  join defaults to the reverse proxy (`http://<ip>` on `:80`) and auto-falls-back to `:3020` on
  a connect failure; `--origin-url` remains the explicit override. (AWS-POC2 finding #1; fix
  2026-07-05.)
- **[Fixed — installer] Shared-Redis cluster is broken by the default origin install.** Origin
  `redis` binds `127.0.0.1:6379`; edges get `redis://<origin>:6379` → every edge's
  LiveKit/ingress/egress crash-looped. Now: (a) an origin installed WITHOUT `--cluster-redis-bind`
  prints a prominent summary warning that edges cannot join until Redis is bound to a reachable
  private IP, with the exact remedy; (b) join mode runs a **Redis TCP preflight** and aborts with
  the origin-side fix instead of crash-looping. Binding via `--cluster-redis-bind <private-ip>`
  remains the supported path. (AWS-POC2 finding #2; fix 2026-07-05.)
- **[Medium] Cross-node egress placement.** In a shared-Redis cluster, `stopEgress` routes to the
  wrong node → twirp timeout, VOD never finalizes / lands on the wrong disk. Needs egress-direct-
  to-S3, shared storage, or room-pinned egress. (AWS-POC2 finding #3; round-1 open item confirmed.)

## Open — installer / release

- **[Medium] Worker image build is a fragile upgrade step.** The Dockerfile builds the deface/yolo
  Python venv (`pip install torch …`) on every (re)build; a network/resolver flake fails the whole
  upgrade (seen live: exit 1 → core not restarted → migration not applied). Fix: prebuilt worker
  images, or make the worker layer optional (`INSTALL_YOLO_WORKER`) + retry, so a worker-build
  hiccup can't block a core upgrade + migration.
- **[Fixed — installer] `VERSION` was stamped from the fetched source, not the running state.**
  A failed upgrade (build error after the source mirror) left `$INSTALL_DIR/VERSION = target`
  even though services still ran old/broken. Now the source mirror **never writes VERSION** (the
  target is captured into `FETCHED_VERSION`); VERSION is stamped only **after** the post-health
  check passes. A failed build/health keeps the old VERSION (so a re-run retries) and preserves
  the pre-upgrade backup + prints rollback guidance. (fix 2026-07-05.)
- **[Fixed] Release artifact leaked dev SQLite DBs.** `make-release-artifact.sh` pruned only root
  `./data`; nested `streamhub-core/data` + `apps/*` (11 `.db` files, incl. a `.bak`) shipped in the
  tarball. Now prunes `data`/`secrets` at any depth + drops every `*.db*`. (commit on 2026-07-05.)

## Open — API consistency / API-first

- **[Medium] Phantom tenant endpoints (SPA → 404).** `api.tenants.*` (client.ts) exposes full CRUD
  but the backend `@Controller('tenants')` implements only `GET /tenants/:id/usage`. The Superadmin
  Tenants screen calls `GET /tenants` and `PATCH /tenants/:id/quotas` → both **404** (verified live).
  Fix: implement the resource-oriented `GET /tenants` (superadmin) + `PATCH /tenants/:id/quotas`, or
  remove the dead client methods + screen. (API-first audit, class 1.)
- **[Low] Doc drift.** ~11 real, resource-shaped endpoints are undocumented in `api/README.md`
  (`apps/:app/presets`, `vods/:id/download`, `apps/:app/logs`, the whole `cluster/*` section, etc.);
  a few view-shaped rollups (`apps/:app/stats`, `apps/:app/sizes`, `system/settings`, `cluster/info`)
  should be blessed as documented aggregate resources. SPA transport layer is otherwise clean
  (single `/api/v1` `request()` helper — no per-view endpoints). (API-first audit, classes 2–3.)
- **[Low] Stream sub-routes key off `streamId`, not the numeric `id`.** `record/start` + `hls/start`
  resolve `:id` as the `stream_id` string (`"room/participant"`, needs URL-encoding); the numeric
  `id` from the list 404s. Accept the numeric id or document the contract. (AWS-POC2 finding #4.)

## Open — observability

- **[Fixed] Prometheus port collision.** The observability stack put Prometheus on `127.0.0.1:9090`,
  which the LiveKit `ingress` debug server already holds on a media node → crash-loop. Moved to
  `${PROMETHEUS_PORT:-9091}`. `/metrics` returns **403** (not 404) when `METRICS_TOKEN` is set —
  documented. (commit on 2026-07-05.)
