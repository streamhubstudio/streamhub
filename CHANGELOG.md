# Changelog

All notable changes to StreamHub. Versions follow the repo-root `VERSION`.

## 3.3.2

### Added
- **HLS direct-serve** (`STREAMHUB_HLS_DIRECT_SERVE`, off by default): the front proxy serves live
  `.ts`/`.m3u8` straight from disk instead of passing them through the core, and falls back to
  the core for anything not on disk. Caddy (compose: read-only data mount + the flag) and nginx
  (`install.sh` fills the vhost root and gives only the nginx user traverse access). Paths with
  dot segments are never served from disk. Trade-offs and how to toggle it:
  `https://streamhub.studio/docs/operations/SCALING`.
- **Fleet battery alert:** agents may report `battery` (percent) in their telemetry; it shows on
  the agent card and in `metrics.battery` (`null` on hosts without one). New fleet setting
  `batteryLowPercent` (default `0` = off) fires `fleet.battery_low` and `fleet.battery_recovered`
  (10-point hysteresis, per agent, payload `{agentId, batteryPercent, thresholdPercent}`) through
  webhooks, MQTT, notifiers and Streamflow triggers.
- **`loadgen hls` finds the knee** ("fly mode", replaces the 2.x `scripts/hls-loadtest.mjs`): stops
  at the first step over `-target-p95`/`-max-error`, plus `-plan`, `-viewers`, `-insecure` and
  master-playlist resolution.

### Docs
- [operations/SCALING](https://streamhub.studio/docs/operations/SCALING) brought over from 2.x and
  updated for the Go core (load-test findings; StreamHub stays on stock LiveKit).

### Changed — ops without Python
- **`streamhub` CLI**: `cluster` and `app` commands no longer need python3 — responses are
  rendered by the new `streamhub-core opsfmt <view>` subcommand (host binary, or the one in the
  core container), byte-identical to the former `python3 -c` output.
- **Installer**: the join-mode parse of the cluster join response is pure shell (no python3);
  python3 is now used only to build the app-worker venv.
- **e2e harness**: the webhook receiver is Go (`test/e2e/receiver`, was `receiver.py`); the
  cluster heartbeat-age check uses `date`.

## 3.3.1

### Changed — decoupled apps
- **Vision apps 0.1.2** (occupancy, counting, crowd, demography): single-node start (edge
  worker-manager co-located), assignment state reported to the master, child processes get only an
  env allowlist.
- **YOLO 1.0.1**: `callbackUrl` is optional (empty = detections are only logged).
- **Transcription 1.0.1**: Studio panel (recent VODs, transcript status, SRT download,
  re-transcribe) and standalone export.

### Fixed
- Parity harness: `-accept` re-baselines the composed-apps digest instead of refusing to run.

## 3.3.0

### Added
- **Cameras app (F1 — console):** the `cameras` Studio App drives OpenCam cameras over the app's
  MQTT broker — live state per camera, PTZ pad with deadman, stream start/stop and temporary HD,
  snapshot, voice test and reboot with per-command phase tracking, and a `config.ini` generator to
  provision a camera from its microSD. Ships `opencam-sim` to simulate cameras against a broker.
  See `https://streamhub.studio/docs/features/cameras`.
- **Samples on their own origin** (`STREAMHUB_SAMPLES_URL`, e.g. `https://samples.example.com`):
  sample pages are served only on that host (with the API, SDK and HLS they call same-origin) and
  never on the dashboard's, whose storage holds the session. `/samples/*` on the dashboard redirects
  there, and the dashboard is never served on the samples host (redirected back). Sample pages,
  embed URLs, the Samples editor (preview, links) and the Radio listener link use it; untouched
  pages move to it at boot. Proxy recipes: `SAMPLES_DOMAIN` in `deploy/Caddyfile`,
  `deploy/nginx-samples.conf`, `install.sh --samples-domain`. Unset = unchanged behaviour.

### Security
- With `STREAMHUB_SAMPLES_URL` set, the 3.2.1 restriction is lifted: editing samples is plain RBAC
  again (owner/editor, app tokens on their own app). Without it, it stays superadmin-only.

## 3.2.1

### Security
- **Editing samples is superadmin-only** (`PUT /apps/:app/samples/:file`, `POST …/samples/regenerate`),
  for every tenant role and for app-scoped API tokens. Samples are served from the dashboard's origin,
  so a stored sample could read the session of whoever opened it. Reading samples is unchanged. This
  is lifted when samples move to their own origin.

## 3.2.0

### Changed — dashboard restyle
- **Always dark**: the light theme and the theme toggle are gone. New "control room" palette (steel-grey
  surfaces, cyan for selection/focus, blue for actions, red/green/amber for state; text at WCAG AA).
  Studio Apps and vendored app frontends inherit it unchanged. The sidebar logo no longer clips.
- **Version always visible** in the sidebar footer (and the mobile top bar). Clicking it opens an
  **About / Build** panel: version, commit, build date, the core's Go toolchain, the dashboard's
  Node/Vite/React, a dashboard↔core build-mismatch warning and "copy build info".
- **Changelog in the app**: the binary embeds `CHANGELOG.md` (`go generate ./internal/buildinfo`);
  new routes `GET /api/v1/system/build` and `GET /api/v1/system/changelog`.

### Fixed
- `PUBLIC_BASE_URL` falls back to `STREAMHUB_PUBLIC_URL` (what `install.sh` sets): WS-ingest
  provisioning and passthrough URLs were relative, and grid/edge workers got no ingest/events URL.
- `hls-player` sample: a missing playlist now shows a player error instead of throwing.
- Studio: the "Worker running" badge reflects the real worker process (running / crashed / stopped).
- ESP32 sketch header, MQTT, fleet, samples and SDK docs aligned with the Go core.

## 3.1.0

### Changed — no Node left in the product
- **Stream-health worker in Go**: `streamhub-core health-worker` (spawned by the plugin framework)
  replaces the Node `health-worker/`. Same env, events, payloads and SQLite; the event sequence was
  diffed against the Node worker on synthetic HLS (silence, desync, low bitrate, stall, CC errors,
  gaps). The runtime image and the native bundle no longer ship `node`; `PLUGIN_NODE` and
  `HEALTH_WORKER_DIR` are gone.
- **Apps tooling in Go**: `streamhub-core apps pull|pack|bump` replaces `scripts/apps-*.mjs`.
  Byte-identical bundles (same content sha256 for every pinned app), so existing `apps.lock.json`
  pins stay valid. Composed backend apps now live in the repo-root `plugins-vendor/`.
- **MCP server in Go**: `streamhub-mcp` (also `streamhub-core mcp`), a single static binary per
  platform on the official Go SDK — same tools, resources, prompts, schemas and destructive-ops gate.
  No more `npx`/Node for AI clients.
- **Smokes and tooling in Go**: `cmd/smoke` (`-read-only`, `-routes`, `conference`, `call`),
  `go generate ./cmd/build-examples`, `loadgen latency`. `scripts/` is gone.
- **The NestJS core is retired from the repo**: parity runs as a replay against the recorded Node
  answers (`test/parity/golden/`, 1343 cases); the 2.x source stays at tag `v2.24.0`.
  `legacy/` removed.
- Node is now only the build toolchain of the dashboard SPA and the browser SDK.

### Fixed
- The smoke's "origin node present" check skips on a standalone core (no cluster configured).
- Vision Edge (`install.sh`): `streamhub-edge.service` writes `VISION_EDGE_LOG`, so the master's node
  logs have something to read.

## 3.0.0

### Changed — the core is Go
- **The core is rewritten in Go** (`streamhub-core-go/`): one static binary (`streamhub-core`,
  pure-Go SQLite, no CGO) replaces the NestJS core. Same contract: same `/api/v1` routes,
  operationIds, JSON, status codes and error texts; same `.env`, `DATA_DIR` layout and SQLite
  schema — the SPA, MCP server, browser SDK, Python apps and 2.x installs work unchanged.
  Verified by a Node↔Go differential parity harness (`cmd/parity`), the dashboard e2e suite
  and a real-media e2e (RTMP/WHIP, HLS, recording, cluster + Vision Edge).
- **The NestJS core is legacy**: `streamhub-core/` stays only as the parity oracle (frozen at
  2.24.0, tag `v2.24.0`); it is no longer built or shipped.
- **No Redis/BullMQ in the core**: upload/transcode/streamflow queues run in-process; pending
  uploads/transcodes are re-enqueued from state at boot.
- **Performance**: HLS fan-out and the REST API scale several times past the Node core.
- **LiveKit pinned to the latest stable**: server v1.13.11, ingress v1.5.0, egress v1.15.0
  (`room.enable_remote_unmute` and `ingress.rtmp_base_url`/`whip_base_url` now set).
- **MCP server in Go**: `streamhub-mcp` (also `streamhub-core mcp`) replaces the Node
  `mcp-server/` — one static binary per platform (darwin/linux/windows × amd64/arm64,
  `deploy/make-mcp.sh`), no Node/npx on the client. Same 89 tools, 3
  resources and 2 prompts, same schemas, env vars, destructive gate and error texts (locked
  by vectors from the TypeScript server). Point the client `command` at the binary
  (`https://streamhub.studio/docs/integrations/MCP`).
- **Native shape**: `deploy/make-core-bundle.sh` + `deploy/deploy-core.sh` install the binary
  under systemd (converting a 2.x Node unit in place) and provision the Python workers' venv
  (`PLUGIN_PYTHON`, `WORKER_DEPS`).

### Fixed (Node bugs)
- Edge workers' results reach the app (edge ingest token accepted; batched vision events).
- stream-health and streamflow routes no longer shadowed by the vision-apps route; fleet
  `command` honours its documented body; deleted/disabled streamflow schedules stop firing.
- A pending edge command whose socket drops answers 504 instead of hanging.
- Graceful shutdown on SIGTERM (workers, WS gateways, MQTT, SQLite).
- Directories are created `0777 &^ umask` so egress (other uid) can write recordings/HLS.

### Security
- **Plugin/app workers no longer inherit the core's environment** (JWT/SMTP/LiveKit secrets,
  API token, S3 keys): only an OS/runtime allowlist + `STREAMHUB_WORKER_ENV_ALLOW`.
- LiveKit webhooks with an empty `LIVEKIT_API_SECRET` are rejected; the IP ban applies to the
  edge WebSocket upgrade.

## 2.24.0

### Changed — app navigation regroup
- The app's vertical tab column slims down: **Tokens, Integraciones and Logs
  move into Config → System** as a horizontal sub-nav
  (`?tab=config&section=system&sub=…`), mounted-always so switching never
  loses in-progress state. Old `?tab=tokens|integraciones|logs` deep links
  redirect (and rewrite) to the new canonical URL.
- **Icons on every tab label** (vertical tabs + Config sections), reusing the
  plugin icon set.

## 2.23.1

### Fixed — docker install path was broken for the decoupled world
- **`deploy/Dockerfile` still COPYied seven decoupled workers' directories**
  (removed from the repo in the 2.20–2.23 exodus), so a fresh
  `install.sh` / `docker compose up --build` died at the first missing COPY.
  Found by the post-release AWS validation run. The worker layer is now
  generic: vendored worker SOURCE already rides inside
  `dist/plugins-vendor/<id>/worker`; a single
  `INSTALL_VENDORED_WORKER_DEPS` build arg (comma list of app ids, `all`, or
  `0`; default `deface`) bakes selected apps' pip deps and no-ops on an
  uncomposed tree. The obsolete per-worker `/opt/worker-src` copies are gone
  (the exporter resolves vendored sources since 2.20). Full multi-stage image
  build validated against the composed tree.
- README/INSTALL still said Node 20 → Node 24.

(Note: the Dockerfile/compose/install.sh changes shipped in commit ebda8182
under a docs-titled message — this entry is the honest record.)

## 2.23.0

### Changed — the decoupling is COMPLETE: 12 Studio Apps in their own repos
- **The four vision apps** (`occupancy`, `counting`, `crowd`, `demography`)
  moved to ONE shared repo (`streamhub-app-vision`) that releases four
  single-app bundles per tag, each embedding the shared vision-edge runtime.
  The in-tree catalog is now 13 built-ins (5 Studio Apps + 8 plugins); ALL
  worker/vision apps (12) compose from version+content-sha pinned releases.
- **Unified vision spawn**: one argv (`-m vision_edge --model <m>`) + one
  env set for both placements; the runtime derives the edge HLS URL from
  VISION_PUBLIC_BASE; the demography API key is structurally withheld from
  any remote frame — now expressible declaratively via the new spawn-template
  `localOnly` filter.

### Added — wave-3 apps & ingest (landed between 2.22 and this release)
- **Live Control**: pause / resume / finish an already-live stream via API + UI
  with covers (image/video/text) served to viewers through the player overlay,
  server-side audio mute, per-app defaults + per-stream overrides, S3 assets,
  `livecontrol.*` events through the funnel.
- **Stream Health**: origin-quality monitor Studio App — packet loss/TS
  continuity, audio silence, A/V desync, stalls, bitrate drops; per-room
  thresholds; `health.*` events via webhooks + MQTT + Streamflow; ~<1% of one
  core per stream (sampling ffprobe, Node worker with zero deps).
- **MPEG-TS over UDP ingest** (unicast + multicast + RFC4607 SSM) as a
  passthrough pull source: `{inputType:'mpegts', url:'udp://@GROUP:PORT'}`,
  validated group/port/sources, re-armed at boot, no transcode by design.
- **Vision edge**: shared capture (one decode loop per source feeding N
  models) + tagged polygon POIs in counting/demography (occupancy/crowd
  already had zones); events carry the POI name.

### Added
- **Per-app timezone** (`timezone:` config, IANA-validated): app-scoped UI
  timestamps render in the app's zone; scheduled-live adopts it as the
  per-event default (explicit event timezone still wins).
- **SMTP per app + per user**: precedence user > app > global with
  best-effort fall-through; app password in data/secrets.json, user password
  AES-256-GCM; test-send endpoints; UI in Integraciones + Account.
- MCP server 0.2.0: 47 → 89 tools covering the whole 2.20-2.22 REST growth.

Totals: composed core 240 suites / 2772 · web 457 node + 127 component ·
runtime pytest 256 · 12 vendored witnesses green.

## 2.22.0

### Added — Streamflow 2.0
- **Per-app encrypted secrets manager**: AES-256-GCM under a per-app HKDF key;
  write-only API (values never readable back), masked listing, `{{secret.NAME}}`
  resolved only server-side at run time, scrubbed from logs and exports.
- **Workflow export/import as JSON** (catalogue-validated, secret-safe).
- **Full event catalogue**: every core/plugin/cluster event now triggers
  workflows (cluster events visible; other apps' events never — test-locked).
- **Execution nodes** — code (sandboxed node:vm), SSH, shell, postgres/mysql
  (parameterized only) — ALL gated behind `streamflow.dangerousNodes`,
  **default OFF**.
- Streamflow appears as a first-class tab inside the app when installed; the
  canvas animates active edges when runs flow through.
- **Per-app + per-stream quotas** (`quotas:` config block, default unlimited).

### Added — Recording/VOD
- `stream.snapshot` event through the callbacks/MQTT/Streamflow funnel +
  `POST /apps/:app/streams/:id/snapshot` on-demand (LiveKit AND passthrough/HLS).
- Filename templates for recordings + snapshots (`${app} ${streamId} ${room}
  ${ts} ${date:…} ${var.NAME}`), applied to local files and S3 keys —
  traversal-safe by construction.
- **VOD retention** per app (`recording.retention_days`: off/7/30/90/180/360) —
  janitor deletes from DB + S3.
- Per-app `variables:` map usable in templates; recording without a configured
  bucket now fails fast (409 `storage_not_configured`) with UI warnings.

### Changed
- Config screen: sections became deep-linkable tabs; presets show **Applied ✓**
  and can be **deactivated** (`POST /apps/:app/presets/:preset/deactivate`).
- Production runtime upgraded to Node 24.

Totals: core 225 suites / 2586 (composed) · web 422 node + 96 component.

## 2.21.0

### Added
- **Token-protected embeddable player widget**: `POST /apps/:app/play-token/:room/sign`
  now returns tokenized `playUrl`/`embedUrl` + iframe snippet; `/embed` validates
  the app+room-scoped expiring HMAC server-side before rendering. No `sk_`/JWT
  ever appears in a snippet.
- **Dual player in Live**: Vidstack | video.js toggle in the HLS view when a
  player provider is active, each with its own embed code.
- **Live rooms**: pagination (20/page), Live/Offline status column, sortable by
  name/viewers/publishers/since/status. Per-stream TAGS editable from Live;
  secondary row actions grouped into a ⋯ menu.
- **Database backups**: per-app accordion, snapshots paginated.
- Public site: edge sizing calculator at /calculator (moved out of the dashboard).

### Fixed
- **Cockpit + Vidstack showed no video**: tiles were hard-wired to WebRTC; each
  tile now resolves its player per camera type (HLS/MJPEG/WebRTC).
- Docs links 404: the dashboard now points at the synced streamhub.studio/docs
  mirror (every deep link verified).
- Every UI timestamp normalized to one shared `YYYY-MM-DD HH:mm:ss` util.
- Resources charts draw connecting lines (gaps stay visible as breaks).
- Corner background glow no longer tiles on long pages.
- Recent-events rows no longer overlap on long log lines (truncate + expand).
- Monorepo CI green end-to-end (identity-verification bypass onto the group
  runner, post-decoupling job de-staling, linux lockfile fix, jest worker cap).

Totals: web 411 node + 83 component · core 222 suites / 2471 (composed) · CI 7/7.

## 2.20.0

### Changed — app decoupling: 8 Studio Apps now live in their own repos
- **`lpr`, `deface`, `safety-ppe`, `people-counter`, `transcription`,
  `presence`, `perimeter`, `yolo`** each moved to
  `gitlab:digitalhub_com_ar/streamhub-app-<id>` with its own versioning and
  CI (test → deterministic bundle → GitLab release). The monorepo pins each
  release in `apps.lock.json` by version + **content sha256** (hash of the
  uncompressed tar — stable across gzip re-runs) and `scripts/apps-pull.mjs`
  composes them into the build, fail-closed on any mismatch.
- **Composed builds are self-contained and portable**: apps-pull copies each
  app's manifest + Python worker INSIDE `streamhub-core/src/plugins-vendor/`
  with a package-relative `workerDir`; `nest build` carries it to `dist/`.
  A deploy tarball or docker image built from a composed tree needs no
  token, no network and no compose step on the server. The decoupled
  backend is the declarative `streamhub.app.json` only — the core runs ZERO
  package JavaScript (spawn-template interpreter, no eval).
- In-tree catalog is now 14 built-ins (7 Studio Apps + 7 plugins); the
  8 decoupled apps join at compose time and are indistinguishable from
  built-ins (locked by per-app composed-witness tests).
- Export/appstore prefer the vendored (version-pinned) worker source over
  `STREAMHUB_WORKER_SRC_ROOT`; the prod smoke's appstore check doubles as a
  composition sentinel.

### Added — test infrastructure
- Synthetic fixture apps (`refapp`/`reftool`/`refoverlay`, discovered only
  under `STREAMHUB_PLUGIN_FIXTURE_ROOT`) replace real shipping apps as test
  fixtures across the suite, so decoupling an app never rewires tests again.

Totals: core 222 suites / 2469 tests (composed, 0 skipped) · web 389 ·
compiled-runtime composition validated (22 plugins discovered from dist/).

## 2.19.0

### Added — app versioning: nothing ever overwrites anything
- **Immutable per-version plugin store** (`DATA_DIR/appstore/`): upload a NEW
  version of any exportable app (same semver → 409 — bump it), built-ins
  materialize automatically as `builtin-<core version>`, every bundle is
  sha256-verified before it ever runs (tampered → loud fallback to builtin,
  never a crash-loop).
- **Pin / rollback per app**: `PUT /apps/:app/plugins/:id/version` +
  rollback backed by a version history; a running worker restarts onto the
  pinned version. `plugin.version_changed` flows through the callbacks
  funnel.
- **`streamhub app` CLI**: `push · versions · pin · unpin · rollback · pull
  (sha256-verified) · delete-version` — the full export → modify → push →
  pin → rollback cycle from the master's terminal.
- **Edge replication**: assignments carry a `bundle {version, sha256, url}`
  ref; edge nodes fetch it from the master (cluster-token), verify, cache
  and spawn from the pinned version — old versions stay cached for instant
  node-local rollback.

### Added — onboarding wizard
- Creating an app opens a purpose-driven, always-skippable wizard
  (surveillance / radio / events / 1:1 / live shopping / general): recording,
  viewer scale, vision models (installs the real plugins), tags, and
  purpose extras — radio creates the passthrough ingress and hands you the
  RTMP URL + key. Finalizar applies everything best-effort with per-item
  results and closes with deep links + the matching published recipe.

### Added — media multi-node Wave A
- **TURN relay** (`--turn` / `STREAMHUB_TURN_ENABLE`, origin + nginx shape):
  dedicated certbot cert for `turn.<domain>`, ports 5349/tcp + 3478/udp,
  enable-after-cert ordering, `streamhub doctor` checks. Clients need
  nothing — ICE servers arrive in the JoinResponse.
- **Egress affinity to the origin (default)**: common-node joins no longer
  run egress (opt-in `--with-egress` with a loud known-limitation warning) —
  cross-node recordings/HLS no longer land on disks the core can't read.
  The definitive fix (S3 as transport) is designed for the next wave.

Totals: core 224 suites / 2492 tests · web 500 + 86 + Playwright 14 · runtime
pytest 219 · shellcheck clean.

## 2.18.0

### Added — every Studio view has a URL + a launcher to reach it
- **Deep links**: `/apps/:app/studio/:pluginId/:section` — every marketplace
  app view (occupancy's Streams, streamflow's Runs, …) is directly
  addressable and shareable; unknown sections redirect to the app's default,
  old section-less URLs keep working. Studio apps declare their sections in
  the frontend plugin contract — no central registry.
- **Studio launcher** in the shell header: pick the tenant app → its
  installed Studio Apps → the view — and it navigates to the deep link.
  Copy-link button on every studio page.
- **Playwright behavioral E2E layer** (`streamhub-web/e2e/`): 14 specs drive
  the real dashboard against a really-booted core — login, CRUD, toggle +
  config persistence across reloads, deep links, tokens, mobile drawer, and
  a full-audit sweep (every page/tab: zero console errors, zero broken API
  calls, no leaked i18n keys). Verdict of the first full run: no real UI
  defects.
- **Manual QA guide** (`testing/MANUAL-QA.md`, Spanish): 72 hand-testable
  cases across 11 suites for a tester with basic knowledge — OBS/ingest,
  playback, rooms, core, every Studio App with its real config, Streamflow,
  IoT, cluster/edge, observability, responsive — with a P1/P2 report matrix.

### Fixed (found by writing/verifying the QA layers)
- **presence events reach webhooks/MQTT again**: the plugin meta never
  declared its worker events, so the spoof guard rejected every
  `presence.*` post — the signed delivery plane was silently dead.
- **Streamflow intrusion template delivers end-to-end**: the notify box
  shipped an empty channels list (delivers nothing) and the condition read
  `ai.confidence` where the AI action outputs `ai.json.confidence`.
- Docs: `STREAMHUB_AUTHZ_ENFORCE` default corrected to `on`; one canonical
  testing-strategy doc (six layers).

## 2.17.2

### Fixed — remote edge nodes are now turnkey (field-test findings)
- **`--node-type edge` now provisions the vision runtime**: the join builds a
  venv (CPU torch wheels by default, CUDA switch documented), installs the
  runtime and writes the `streamhub-vision-edge` shim — the systemd unit goes
  live and dials the master immediately. Best-effort/idempotent; skip with
  `STREAMHUB_NO_EDGE_RUNTIME=1`.
- **Edge workers run with the edge's own interpreter**: a python argv[0] in a
  master-resolved spawn is rewritten to the node's venv python
  (`VISION_EDGE_PYTHON` overrides); non-python commands stay verbatim.
- **Half-open control channels self-heal**: the gateway marks a node
  disconnected on socket error immediately (a re-register from the same node
  swaps sockets cleanly), and the edge force-reconnects after 30s without a
  master frame (`VISION_EDGE_WS_IDLE_TIMEOUT`).
- **Choppy HLS no longer idles a worker**: capture reopens on a bounded
  2→5→10s backoff with ffmpeg open/read timeouts — a stream gap is always
  recoverable, only stop() exits the loop.
- Totals: runtime pytest 197 · core 217 suites / 2440 tests · shellcheck clean.

## 2.17.1

### Fixed — installer (found by field-testing the upgrade path on AWS)
- **Fresh installs from the release tarball failed at `COPY VERSION`** and
  **upgrades baked the OLD version into the rebuilt image** (health/dashboard
  reported the previous release). Root cause: the source mirror deliberately
  preserves the stamped `VERSION`, so the build never saw the target's. The
  installer now writes the TARGET version for the image build and restores the
  previous stamp if the build fails (the authoritative post-verify stamp is
  unchanged).
- **In-place origin upgrades false-positived the port preflight**: the
  host-network core's socket owner reports as node's `MainThread`, which the
  ours-on-re-run whitelist didn't match.
- **`.join-profile` now also persists the node NAME** — a bare
  `streamhub upgrade` on a node re-registered under the hostname, duplicating
  the registry entry.

## 2.17.0

### Added — Cluster Ops
- **Edge nodes in Prometheus/Grafana via the master**: edge nodes are
  NAT-friendly (no inbound port), so the master now re-exports the per-node
  telemetry it already holds — `/metrics` gains 10 cluster gauges (node
  up/cpu/mem/disk/gpu/vram-free/weight + assignments by status + pending +
  eligible nodes by GPU). New auto-provisioned **edge-nodes Grafana
  dashboard** (13 panels) + 2 Prometheus capacity alert rules in
  `deploy/observability/` — the same one-command compose stack, extended.
- **"No capacity" alert**: when work parks with no eligible node, or a node
  failure leaves GPU work unplaceable, a rate-limited `cluster.capacity`
  event fans out through the notifier (global + per-app `cluster.notify`,
  incl. MQTT) and lands in the central log.
- **Central cluster events**: scheduler placement / failover / reoffer /
  no-eligible outcomes are logged to `server_logs` (`source:'edge'`) —
  queryable from the main app via `GET /api/v1/logs?source=edge`.
- **`streamhub cluster` CLI** on the master: `status` (nodes with
  cpu/mem/disk/gpu/vram/weight + assignments summary), `restart|reboot
  <node>`, `drain|activate <node>`, `weight <node> <n>`, `events`.
- **Per-node weight/type editor** in the dashboard's Cluster → Edge tab
  (heavier GPU ⇒ bigger share under the `weighted` scheduler policy).
- **`install.sh --no-plugins`**: media-server-only install — empty plugin
  catalog, no worker spawns, deface worker not baked into the image.

### Changed — 100% responsive, mobile-first
- **Dashboard**: every modal caps at the viewport height and scrolls
  internally; toasts fit 320px; section headers, grids and header rows stack
  or wrap on mobile; meeting view stacks video/chat; zone/flow canvases are
  layout-safe on phones with a "best edited on a larger screen" hint. The
  off-canvas drawer/hamburger shell is locked by new component tests.
- **Site**: the top nav no longer overflows in the 768–1279 px band (the
  desktop row now appears only where it fits — worst case was Spanish
  labels); the hamburger drawer covers everything below.

### Fixed
- `operations/OBSERVABILITY.md` wrongly documented `/metrics` as public — it
  is default-DENY behind `METRICS_TOKEN`.
- Totals: core 217 suites / 2436 tests · web 465 + 75 · shellcheck clean.

## 2.16.0

### Changed — Edge is a capability, not an app
- **The `vision` Studio App is split into 4 first-class marketplace apps** —
  `occupancy`, `counting`, `crowd`, `demography` — each with its own per-app
  database, config schema and declared events, sharing the
  `vision-edge-runtime` worker (one single-model worker-manager per app).
  Existing `vision` installs are migrated **automatically and idempotently at
  boot**: `vision.db` is backed up and split into the four per-app dbs,
  enabled model flags become app installs, existing edge assignments are
  re-pointed, and migrated workers come back running.
- **`worker.edge: true` in the plugin contract** marks any app edge-capable
  (exposed on the manifest → "Edge" badge in Studio). Declared by the 4 vision
  apps + lpr, presence, deface, yolo, safety-ppe, perimeter, people-counter.
  transcription/cockpit/fleet/streamflow remain local-only.
- **Generic per-app edge scheduling** — `GET/POST/DELETE
  /apps/:app/edge/assignments {pluginId, streamId}`: any edge-capable app's
  streams can be placed per-stream across edge nodes (node1 → stream1+2 of
  occupancy, node2 → stream3+4 of LPR…). The spawn resolver has no
  plugin-specific cases left; secrets never leave the master.
- **Dashboard**: the Cluster page gains an **Edge** tab (edge-node cards with
  GPU/disk telemetry + restart/reboot, the app·plugin·stream→node assignments
  matrix, and the Sizing calculator — moved out of the vision tab). The 4 apps
  get standard Studio tabs (zones / crossing-line / ROI editors per model).

### Added / Fixed
- **Workers survive core restarts**: plugin workers persist a desired state
  (running/stopped) and are resumed at boot — a deploy/reboot no longer leaves
  LPR/perimeter/presence detection silently off.
- **Joined nodes keep their role on upgrade**: every join persists a
  `.join-profile`; a bare `sudo streamhub upgrade` on a common/edge node now
  resumes as that node (previously it re-ran the installer in origin mode).
- **`VISION_ENGINE` actually reaches the demography worker** (was a silent
  no-op: core emits the env var, the runtime only read config) and the shared
  model-weight cache (`VISION_MODEL_DIR`) is honored.
- Step-by-step guides: `operations/MANUAL-BUILD-INSTALL.md`,
  `development/EXTENDING-STUDIO-APPS.md`, `operations/CLUSTER-UPDATES.md`.
- Totals: core 214 suites / 2411 tests · web 465 + 69 · runtime pytest 188.

## 2.15.0

### Added — Streamflow: visual event workflows (Studio App)
- **n8n-style workflow engine** (`streamflow` Studio App, in-core, no worker):
  chain boxes with inputs/outputs — triggers (event with wildcards/room/tags/
  predicate, MQTT topic, schedule, manual), actions (snapshot, AI analysis via
  OpenAI/DeepSeek, S3 upload, HTTP POST, MQTT publish, emit event, notify),
  logic (condition rule-builder, delay, transform). Per-app `streamflow.db`
  (workflows / runs / run steps / AI usage), BullMQ-backed runner with inline
  fallback, budget-capped + SSRF-guarded AI client.
- **Visual node canvas** in the dashboard: drag-to-connect SVG editor with
  per-box config panels, workflow list + run history, EN/ES. Ships with an
  intrusion template (perimeter event → snapshot → AI analysis → condition →
  notify).
- New callback events: `streamflow.run_started/run_finished/run_failed/output`.

### Added — IoT secure data plane (ESP32 socket + MQTT-in)
- **`iot.data` event**: every inbound device message becomes
  `dispatch(app,'iot.data',{topic,deviceId,data,source})` — fanning out to
  webhooks, MQTT and Streamflow through the one funnel.
- **ws-ingest structured data frames**: the same `/ingest/ws` socket (same
  `wsk_` key) now accepts `{"type":"data","topic":…,"data":{…}}` — slugged
  topic, 16 KB size cap, bounded JSON depth, per-second rate bucket; malformed
  input is dropped, never crashes the socket.
- **Generic MQTT data-in** (`mqtt.subscribe` per-app config): SSRF-guarded
  subscriber that turns broker messages into `iot.data` events — this makes the
  Streamflow `trigger.mqtt` box fire end-to-end; plus a new `action.mqtt` box
  (publish to an arbitrary app-namespaced topic via `publishRaw`).
- **Security**: the in-app IP allow/blocklist + auto-ban now also guards the
  WS **upgrade** path (`/ingest/ws`, `/live/ws`) — banned IPs get a bare 403
  before the handshake (reuses `STREAMHUB_IP_*`, no new env).
- **The ws-ingest gap is closed**: a REAL in-process WebSocket e2e (handshake →
  JPEG → `/live/.../frame.jpg` round-trip → data frame → `iot.data` dispatch)
  plus first-ever gateway upgrade-routing specs. Core: 205 suites / 2361 tests.

## 2.14.1

### Added / Fixed
- **Cluster: the master (origin) now reports its DISK** in `selfStats` (DATA_DIR
  filesystem usage), so the cluster/edge nodes UI shows the master's storage —
  the deploy is now fully cluster-associated with complete stats.
- **Production smoke suite** (`scripts/prod-smoke.mjs`) + **scheduled CI job**
  `prod:smoke`: read-only + reversible probes of every major live API surface
  (health, RBAC, Studio taxonomy + export, passthrough ingress, tags, net
  metrics, vision, cluster/edge nodes incl. origin disk). Plus
  `testing/TEST-STRATEGY.md` (the five test layers + how each runs automatically).

## 2.14.0

### Added — Vision Edge sizing & pricing calculator
- **Sizing tab in the vision Studio App** — dimension a deployment live: pick
  cameras, models per camera, resolution, inference cadence, GPU, ingest mode
  (passthrough / transcode), viewers and cloud provider → GPUs needed,
  cameras-per-GPU (throughput- or VRAM-bound), agent/master limits, ingress+
  egress bandwidth (GB/mo) and **approximate monthly cost on AWS / DigitalOcean
  / Azure**. Pure client-side model, unit-validated against the real benchmark.
- The capacity numbers are **MEASURED on a Tesla T4** (FP16, process-isolated):
  occupancy/counting yolo11m+ByteTrack ~77 FPS/proc @101 MB, GPU aggregate
  ceiling ~145 FPS ⇒ ~36 occupancy cams/T4 at a 4 fps sampled cadence; other
  GPUs extrapolated (±30%), cloud prices approximate. See
  `features/vision-sizing.md`.

## 2.13.0

### Added — Vision Edge cluster (waves 1+2)
- **Edge node type** — `install.sh --node-type edge` turns a box into a
  worker/compute node: it joins the cluster and holds ONE outbound WebSocket
  to the master (`wss /api/v1/edge/ws`, cluster-token auth) — NAT-friendly, no
  inbound port, no public endpoint on the edge. The channel carries telemetry
  (cpu/mem/**disk**/gpu), worker **assignments**, commands
  (**restart/reboot/ping**) and remote log tail. Watchdog fires
  `node.online/offline`; scheduler policies `round_robin` / `weighted` (per-node
  `%` weight) with VRAM capacity guard, failover/failback and a pending-retry
  reconcile. Edge nodes can run ANY worker plugin (vision-first).
- **`vision` Studio App + `streamhub-vision-edge` runtime** — realtime
  computer-vision suite based on Vision One: **occupancy** (YOLO11+ByteTrack,
  multi-**polygon** tagged zones, sessions, alerts), **people counting
  realtime** (line-crossing at fixed cadence — replaces Vision One's nightly
  batch design), **crowd** (multi-cycle threshold), **demography**
  (InsightFace local default; **OpenAI/DeepSeek** opt-in per config with a
  monthly budget cap). Per-stream settings resolved defaults→tags→stream; a
  polygon/line editor over the live player; every detection → signed callback
  + MQTT + per-app rotated log + `vision.db`. Mono-node runs the same runtime
  co-located via the plugin worker lifecycle.
- **Dynamic stream TAGS** — per-app tag entities (`slug/label/kind/config`)
  applied to streams/rooms; detections carry their tags; full CRUD API.
- **Notifier fan-out** — callback/MQTT/email/**Discord**/**Telegram** with
  rate-limiting (`STREAMHUB_NOTIFY_*` env + per-app `notifications:` block).
- **Per-app network I/O accounting** — ingress/egress bytes through the app
  (HLS + MediaMTX + LiveKit egress), dashboard NetworkCard with sparkline,
  configurable `network.threshold_gb_day` firing
  `network.threshold_exceeded/recovered`.
- Structured config saves now PRESERVE unknown yaml blocks (raw-editor parity).

## 2.12.0

### Added — single-port RTMP ingest (:1935 for everything)
- **MediaMTX front (opt-in)** — one public RTMP port for BOTH ingest planes:
  MediaMTX owns `:1935` and the core classifies every publish by stream key —
  `ptk_*` ⇒ passthrough (pull remux `-c copy` → HLS, no transcode), anything
  else ⇒ forwarded to the LiveKit ingress moved to internal `:11935`. No more
  per-ingress ports (1937/1938/…). Push URLs keep their exact paths; only the
  passthrough port changes. OFF by default (`STREAMHUB_MEDIAMTX_ENABLE`) — with
  the flag unset, behavior is byte-identical to 2.11 multi-port.
- **Restart resilience** — on boot the core re-arms remuxes/forwards for every
  path still `ready` on the MediaMTX API (`/v3/paths/list`), so a core deploy
  no longer drops live passthrough channels until the encoder reconnects
  (validated live: HLS resumed mid-publish with no publisher reconnect).
- Internal loopback/LAN-guarded hook API (`/api/v1/internal/mediamtx/*`,
  mandatory shared secret via header or `?secret=`), `deploy/mediamtx.yml`
  (validated on the real v1.19.2 binary), compose profile `mediamtx`
  (`bluenviron/mediamtx:1.19.2-ffmpeg` pinned), bare-node systemd unit +
  installer opt-in (`--mediamtx`, sha256-pinned binary). New env:
  `STREAMHUB_MEDIAMTX_ENABLE/_HOOK_SECRET/_RTMP_PORT/_API_URL`,
  `STREAMHUB_LIVEKIT_INGRESS_RTMP_PORT`. See `features/rtmp-single-port.md`.

### Fixed
- Passthrough no longer dies on every bare-node deploy: the deploy script's
  regenerated `.env` now persists `STREAMHUB_RTMP_PASSTHROUGH_ENABLE` (the
  2.11.0 deploy silently disabled the radios' ingest plane).

## 2.11.0

### Added — Plugins vs Studio Apps taxonomy
- **`kind: 'plugin' | 'app'` on the plugin contract** (default `'plugin'`, fully
  backward compatible) — a real product split between **Studio Apps** (full
  applications: own database, managed worker, full-page dashboard view,
  exportable) and **plugins** (lightweight in-process extensions: overlays,
  players, panels). 10 apps (lpr, safety-ppe, perimeter, presence,
  people-counter, fleet, yolo, deface, transcription, cockpit) / 7 plugins.
  Manifests also declare `storage` (owned SQLite, e.g. `lpr.db`) and
  `exportable`. See `features/STUDIO-APPS.md`.
- **Full-page Studio App view** — installed apps open at
  `apps/:app/studio/:pluginId` (header with version/worker/enable, the app's
  real UI full-bleed — the CCTV cockpit leaves the modal — and Overview /
  Settings / Logs / Export tabs). Marketplace + per-app Studio tab split into
  **Apps** and **Plugins** shelves with a "Your apps" quick launch. Simple
  plugins keep the modal. EN+ES.
- **Export to standalone** — `GET /apps/:app/plugins/:id/export` downloads
  `streamhub-app-<id>-<version>.tar.gz`: the worker source + generated
  Dockerfile + docker-compose + `.env.example` + README, ready to run on your
  own infra against any StreamHub over HTTPS (HLS via `*_PUBLIC_BASE`, events
  via the HMAC-signed webhook plane). Placeholders only — secrets are blanked,
  never embedded. 7 apps exportable (5 vision + yolo + deface). The docker
  core image now ships worker sources (source-only) at `/opt/worker-src`.

## 2.10.1

### Fixed
- **Studio catalog showed the wrong plugin version** — the global marketplace read
  the version from the frontend plugin module (defaulted 1.0.0) instead of the
  backend manifest (source of truth). The catalog now prefers the backend
  manifest version (`rec.version ?? reg.version`), and the vision plugins' frontend
  modules were aligned to their manifest version (0.1.0).

## 2.10.0

### Added
- **Studio** — the plugin/app surface is rebranded **Studio** in the dashboard
  (route `/studio`, tab "Studio"; API/code stay `plugins`). Every plugin now
  carries a **semver `version`**; each opens an in-app **detail view** (version
  badge + bilingual mini-landing + reused config form + logs). Marketing site:
  a `/studio` hub + a landing page per vision plugin (EN default + ES).
- **Fleet plugin** (nodos.dev-style agent/device fleet management over MQTT) —
  connect to the StreamHub Agents of an app via the app's MQTT broker, see live
  **metrics** (cpu/mem/temp/uptime/version/cameras), and **control** them:
  restart, **OTA update** (sha256-verified download + atomic swap + rollback),
  push config, ping. In-core `modules/fleet` subscriber + `FleetController`
  (`/apps/:app/plugins/fleet/*`) + per-app `fleet.db` + Fleet dashboard panel.
  A Python MQTT companion (`fleet_agent.py`) ships in the StreamHub Agent
  (`fleet-mqtt`, agent v1.13) — telemetry (MQTT LWT for offline), command
  handlers. See `features/fleet.md`.
- **Agent ONVIF discovery** (agent v1.12) — `streamhub-agent onvif scan/sync`:
  WS-Discovery on the LAN → Profile S RTSP URIs → auto-registers cameras as
  StreamHub ingresses (Wave 1 of the CCTV plan).

## 2.9.0

### Added — CCTV / vision plugin wave
- **5 new realtime vision plugins** (all: managed Python worker, per-plugin SQLite,
  HMAC-signed events, edge/GRID-ready pure workers, min-requirements documented):
  **presence** (workstation zones, absent/returned/after-hours), **people-counter**
  (line-crossing count with a live draw/rotate line editor; Vision One logic +
  tuned ByteTrack), **perimeter** (armed-schedule intrusion + evidence JPEG/clip +
  alert queue), **lpr** (open-source fast-alpr MIT, whitelist/blacklist, barrier
  webhook recipe), **safety-ppe** (EXPERIMENTAL — open ONNX PPE model, advisory only).
- **Generic plugin event/data channel**: `POST /apps/:app/plugins/:id/events`
  (ingest-token auth, spoof guard, relays through signed app callbacks + MQTT) and
  authenticated `GET :id/data` / `live/state` for app-tab worker panels.
- **CCTV market plan** (internal design notes): ONVIF-in-Agent
  wedge, camera registry/wall roadmap, open-source + consulting business model,
  StreamYard-like `studio` plugin design.

## 2.8.7

### Added
- **SRT in the dashboard** — the create-ingress form gains "SRT (push)": selecting
  it locks passthrough mode ON (per the backend rule), disables transcode/backup,
  and explains the model (UDP, ~120 ms, the key travels as `streamid` — the key IS
  the credential, no user/password). The result view reveals the `srt://…?streamid=…`
  push URL + key + HLS/player URLs + latency; SRT badges on the ingress list; the
  URL-pull type hints `srt://` sources.
- **HLS playback on `/play` and `/embed`** — the public player probes the room's
  HLS playlist and defaults to HLS playback when live (WebRTC | HLS toggle on
  /play), so **passthrough channels are now watchable** on their player pages —
  and this is the surface where an active **player-provider plugin (Vidstack)**
  renders, including for anonymous viewers. No playlist → prior WebRTC-only
  behavior unchanged.
- **"Compartir" menu on live stream rows** — copy the player URL, the `/embed`
  iframe snippet, the public HLS `.m3u8` URL, or a self-contained video.js embed
  snippet straight from the Streams tab. Passthrough rows open their HLS directly
  (no LiveKit egress round-trip) and hide actions that don't apply.

## 2.8.6

### Fixed
- **Streams reconcile was killing passthrough rows** — the LiveKit reconcile
  prunes active rows whose room has no live LiveKit publisher, and a passthrough
  room never exists in LiveKit, so the 2.8.5 mirrored rows were ended on every
  Streams list. Passthrough rows (`participant='passthrough'`) are now exempt
  from the prune (same precedent as ws-mjpeg: liveness owned elsewhere), and the
  passthrough sync re-upserts EVERY live tick (self-healing if anything else
  ends the row). The dashboard Streams view now reliably shows live passthrough
  channels.

## 2.8.5

### Fixed
- **Passthrough channels were invisible in the dashboard Streams view** — a
  passthrough ingest bypasses LiveKit, so no webhook ever created its `streams`
  row: the dashboard said "no active streams" while HLS was on air. The
  passthrough service now mirrors live remuxes into the per-app streams table
  (15s sync on playlist freshness: fresh ⇒ ACTIVE `<room>/passthrough` row;
  stale/stopped/deleted ⇒ ended). Best-effort — the media plane never depends
  on the dashboard write. +4 specs.

## 2.8.4

### Added
- **SRT ingest** — two paths: (1) **SRT push → passthrough** (remux → HLS,
  near-zero CPU): `POST /apps/:app/ingress {inputType:'srt', mode:'passthrough'}`
  arms an ffmpeg SRT **listener** (`srt://0.0.0.0:<port>?mode=listener`, `-c copy`)
  and returns `srt_url` (`srt://<host>:<port>?streamid=<key>`); reuses the
  passthrough gate + port pool (SRT is UDP — open the same ports as udp). SRT
  requires passthrough mode (LiveKit's ingress API has no SRT input type);
  enforced at the DTO + controller. (2) **SRT URL-pull** for the transcode path:
  `{inputType:'url', url:'srt://source:port'}` — LiveKit pulls via GStreamer
  `srtsrc` (server-version dependent); the SSRF pull-guard rules for srt:// are
  regression-locked (public ok; loopback/metadata 400). +34 tests (152 suites /
  1874). Docs: `features/rtmp-passthrough.md` (now RTMP/SRT).

## 2.8.3

### Changed — ingest profile switch (stability hardening + instant rollback)
- **New global switch `STREAMHUB_INGEST_PROFILE`** (`livekit` | `efficient`) for
  how the LiveKit-transcoded RTMP/URL ingress is encoded. **Default: `livekit`**
  — the stable legacy routing where StreamHub attaches NO encoding opinions and
  LiveKit decides everything (pre-2.7.1 behaviour); **new installs always start
  here**. `efficient` is the opt-in experimental profile: an explicit
  **single-layer preset** (capped 3-layer preset when the app enables adaptive)
  so LiveKit's CPU-heavy 3-layer default can't leak through (measured: 3×1080p
  ≈ 100% → ~24% of 8 cores). Server-wide, per node in a cluster; restart to
  apply; flipping back to `livekit` is the instant rollback. See
  `features/efficient-transcode.md`.
- **Presets only** — the efficient profile now exclusively sends LiveKit's
  built-in `IngressVideoEncodingPreset` values (never custom encoding layers,
  which proved LiveKit-version-coupled — the 2.8.2 H264_MAIN incident). Sub-720
  caps fold up to the 720p preset; adaptive uses the matching capped 3-layer
  preset.
- **Fallback-on-reject** — if LiveKit rejects StreamHub's encoding options, the
  create logs a warning and retries once with LiveKit defaults: options can
  only degrade the profile, never break ingress creation.
- **Audio-only footgun closed** — LiveKit (≤1.8.4) ignores the `audioOnly`
  ingress flag, and an option-less ingress falls back to the 3-layer default
  (the opposite of what the flag promises). `audioOnly` is now DEPRECATED on
  the API (kept for back-compat); under the efficient profile it still pins the
  single-layer preset (worst case 1 layer, never 3); radios should use the
  RTMP→HLS passthrough mode.

## 2.8.2

### Fixed
- **Efficient transcode profile rejected by LiveKit ("video codec unsupported").**
  The 2.8.1 encoding builder set `IngressVideoEncodingOptions.videoCodec` to
  `H264_MAIN`, which the LiveKit ingress (validated against server 1.8.4) rejects —
  so creating a transcoded ingress for an adaptive app (the default) failed with a
  503. Use `H264_BASELINE` (widest-compat live profile; probed against the live
  server). Regression-locked. Unit tests mock the ingress client, so this only
  surfaced under a real functional test against LiveKit.

## 2.8.1

### Fixed / Added
- **Efficient transcode profile — no more CPU blow-ups on the RTMP ingress.** The
  LiveKit ingress used to fall back to LiveKit's **default 3-layer 720p simulcast**
  (three software x264 encodes per stream) whenever explicit video options weren't
  attached — which pinned an 8-core box at ~100% with just 3 streams. Now
  `createIngress` **always** attaches explicit **single-layer** video options by
  default (the safeguard: never an accidental 3-layer), and a new per-app
  **`webrtc.transcode_max_height`** (`360 | 480 | 720 | 1080`, default `720`) caps
  the resolution. **Measured on prod (3× 1080p sources, 8-core box): 3-layer 720p
  ≈ 100% → 1-layer ≈ 24%.** (The output cap is decode-bound for high-res sources,
  so 720/480/360 land near the same ~24% — the layer count, not the cap, is the CPU
  lever; see `features/efficient-transcode.md`.) `webrtc.adaptive: true` gives a ladder,
  but **capped** at `transcode_max_height` (so adaptive can't explode CPU either).
  Pure per-app config, consumed at ingress-create on whichever node owns the room —
  scales locally and across the cluster with no central state. New
  `features/efficient-transcode.md`; `IngressVideoEncodingOptions` builder with 19
  unit tests.

## 2.8.0

### Added
- **RTMP→HLS passthrough (remux, no transcode) — AntMedia parity, near-zero CPU
  without a GPU.** A new ingest mode: `POST /apps/:app/ingress {mode:'passthrough'}`
  ingests RTMP and **remuxes it straight to HLS** (`ffmpeg -c copy`), bypassing
  LiveKit entirely — no video encode at all, so CPU is near-idle even without a
  GPU. This is the no-transcode path LiveKit can't offer (its RTMP ingress always
  transcodes). **Additive and safe:** LiveKit's `:1935` and the whole
  WebRTC/transcode/egress/recording path are untouched; passthrough runs a
  separate ingest on `:1937` and is **env-gated OFF by default**
  (`STREAMHUB_RTMP_PASSTHROUGH_ENABLE`, port `STREAMHUB_RTMP_PASSTHROUGH_PORT`).
  **Mutually exclusive** with transcoding/adaptive (enforced in config): turning
  on passthrough forces `rtmp.transcode`/`transcoding.enabled`/`webrtc.adaptive`
  off, and vice-versa. The API returns a `capabilities` block enumerating what a
  remux gives up (no WebRTC/sub-second, no ABR ladder, source must be H.264/AAC,
  no egress recording, no room features) so the UI can warn. The existing HLS
  player plays it with no change. Implemented with **zero new dependencies**
  (`ffmpeg -listen`, not a bundled RTMP server). See `features/rtmp-passthrough.md`.
- **Audio-only ingest** already shipped in 2.7.2 remains the recommended path for
  a **radio** (drops the video track → the trivial-audio-transcode path); use
  passthrough when you need to carry video with no re-encode.

## 2.7.2

### Added
- **Audio-only ingest (radio) — near-idle CPU without a GPU** — `POST
  /apps/:app/ingress {audioOnly:true}` sets LiveKit's `audioOnly` so the ingress
  DROPS the incoming video track: no video encode at all (the ~1 core/channel
  cost of software x264), leaving only the trivial AAC→Opus audio transcode. For
  a radio/podcast this collapses ingress CPU from ~85%/channel to ~1-2%. Since
  RTMP cannot passthrough on LiveKit (it always transcodes video), this is the
  no-GPU path to very low CPU for audio channels. New `CreateIngressInput.audioOnly`
  + `audioOnly` regression tests. (Video passthrough without transcoding needs
  WHIP, or a future RTMP→HLS remux path.)

## 2.7.1

### Fixed
- **RTMP ingress pinned CPU with a forced 3-layer simulcast, unaffected by the
  adaptive/transcoding toggles** — a transcoded RTMP/URL ingress used LiveKit's
  default **3-layer 720p H.264 simulcast** (three real-time encodes), which no
  app setting could reduce, so turning "adaptive"/"transcoding" off in the config
  never lowered the load. Now `webrtc.adaptive: false` wires an explicit
  **single-layer** ingress preset (`H264_720P_30FPS_1_LAYER`) — ~3× less ingress
  CPU — so the toggle actually controls the transcode. Default keeps the
  simulcast ladder (back-compat). Takes effect on newly-created ingresses (delete
  + recreate to apply to an existing one). New `CreateIngressInput.simulcast`;
  regression tests in `livekit.service.ingress.spec.ts`.

## 2.7.0

### Added
- **Swappable advanced player (Vidstack) as a plugin** — a new `player` plugin
  slot: when an app enables a player-provider plugin, the HLS + VOD/MP4 player
  renders it instead of the built-in video.js player (falls back to video.js
  otherwise); WebRTC sub-second live is untouched. First provider = **Vidstack**
  (`@vidstack/react` + local hls.js) — modern, modular, accessible, HLS/DASH/DRM
  capable. Anonymous `/play` + `/embed` resolve the provider too. Foundation for
  an OTT that serves both live + VOD. See `features/players.md`.
- **Per-stream plugin opt-out** — a plugin enabled on an app still applies to
  every live stream by default, but you can now edit a stream and disable
  specific plugins for that stream only (`streams.disabled_plugins`; `GET/PATCH
  /apps/:app/streams/:id/plugins`; overlay endpoints gained `?stream=&room=`).
  Other streams are unaffected. StreamsTab per-stream plugin editor.
- **CDN / VOD delivery playbook** (`features/CDN-VOD.md`) — serve VOD via an
  external CDN in front of S3 (`s3.public_url`), live HLS via a CDN + the 2.5.0
  cache headers, or the **cluster's own edge nodes as a pull-through CDN**
  (`deploy/nginx-hls-edge.conf`). Hybrid recipes for an OTT.

### Testing
- **Real component/DOM testing** (vitest + jsdom + testing-library) added to the
  web suite — it mounts React components and exercises DOM behaviour (the layer
  the logic-only `node --test` suite was blind to). Caught + regression-locks the
  controlled-Switcher bug; covers the player swap + the Vidstack mount + the
  per-stream editor. Wired into CI (`npm run test:components`).

### Fixed
- **Every dashboard toggle was stuck off** — the controlled `Switcher` reported
  the current value to `onChange` instead of the intended new one, so plugin /
  recording / config toggles could never turn on. Report the new value.
- **RTMP/URL ingress `transcoding bypass` rejection** — `enableTranscoding:false`
  (bypass) is WHIP-only; LiveKit rejects it for RTMP/URL ("bypassing transcoding
  impossible with selected input type"). Only forward the bypass flag for WHIP.
- **CI ran on node:20** while the project targets Node 24 (`engines>=24`) — Jest
  30's transform uses `crypto.hash()` (Node 21+), so all core suites failed to
  transform. Bumped CI images to node:24.

## 2.6.0

### Added
- **Dynamic media-pipeline diagram per app** — `GET /apps/:app/pipeline` resolves the
  app's real topology (ingest RTMP/RTMPS/WHIP/WebRTC/RTSP/WS-MJPEG, transcoding
  gpu/cpu + adaptive ladder, delivery WebRTC/HLS/CDN, recording→S3, plugins, live
  streams) from `config.yaml` + live hints; the dashboard **Overview** renders it as
  an animated SVG flow (`AppFlowDiagram`) that only shows enabled stages, with
  active-vs-configured pulses, theme-aware + `prefers-reduced-motion`.
- **Primary + backup RTMP stream keys** (Dacast/Vimeo-style failover) — `POST
  /apps/:app/ingress {backup:true}` mints a second LiveKit ingress bound to the
  **same room** (distinct identity) → identical HLS/WebRTC playback URL whichever
  key is live; backup-as-standby, primary preferred. Dashboard shows both keys.
- **Endless Radio / 24-7 linear-channel hardening** (all behind `features.linear.*`,
  default off): persistent-room `emptyTimeout` so a source outage doesn't recycle
  the room/SID; auto-HLS watchdog; a `broadcaster` quota preset
  (`maxConcurrentStreams:-1`); DVR bounded live manifest (`livePlaylistName` +
  `.ts` retention janitor). Gap audit in `features/ENDLESS-RADIO-STATUS.md`.
- **Cluster observability stack** — `deploy/observability/` cluster overlay:
  Prometheus (3-node scrape via nginx metrics-export allowlisted to the master) +
  Loki/Promtail log ingestion + Grafana `cluster-overview`/`cluster-logs`
  dashboards + install scripts. `operations/CLUSTER-OBSERVABILITY.md`.

### Fixed
- Observability: Grafana Prometheus datasource `:9090→:9091`; Loki
  `common.instance_addr=127.0.0.1` (single-binary on a docker host advertised its
  ring on docker0 → self-dial refused / push 500).

## 2.5.0

Cluster becomes a real distribution fabric (phase 1) — see
`https://streamhub.studio/docs/architecture/CLUSTER-ROADMAP`.

### Added
- **Node roles + edge login-lock** — a node now has a DB-driven role
  (`standalone | master | edge`, in `_streamhub_meta`). An **edge serves the
  portal but blocks login** (`AuthService.requireSecret` → 403), so a cluster
  node can't be used as a standalone app; the SPA shows a "manage at the master"
  screen. `GET /auth/config` exposes `nodeRole/masterUrl/loginEnabled`.
- **Standalone ↔ cluster conversion** — `POST /cluster/join-master` (become an
  edge of a master) and `POST /cluster/leave` (revert to standalone). Master
  promotion (`promote`) + the installer "edges run a core" change are the next
  phase.
- **GRID-1 — remote GPU worker offload** — plugin workers with
  `placement: 'grid'` now dispatch to a BYO-GPU node: a `X-Cluster-Token`-gated
  grid agent (`POST /api/v1/grid/workers` + status/stop/logs) runs the worker on
  the node; the origin injects `originUrl` so results post back; the heartbeat
  advertises a `grid` GPU block via `nvidia-smi`. `yolo` ships as the reference
  (`placement: 'grid'`, falls back to local when no GPU node matches). New
  `https://streamhub.studio/docs/features/GRID`.
- **HLS edge/CDN caching** — correct `Cache-Control` on `/hls` (`.ts` immutable,
  `.m3u8` no-cache by default; `STREAMHUB_HLS_CDN` opts into short SWR for a CDN)
  + ready-to-use nginx/Caddy edge-cache configs. New `features/HLS-CDN.md`.

### Security
- **Cluster join no longer vends secrets over plaintext** — the LiveKit
  apiSecret + Redis URL are withheld from the `POST /cluster/join` response
  unless the request arrived over TLS (`X-Forwarded-Proto=https`/`req.secure`/
  loopback); `STREAMHUB_CLUSTER_REQUIRE_TLS` (default on).
- **Cluster-token brute-force now feeds the auto-ban** — a failed
  `X-Cluster-Token` records an `invalid_token` offense, so the network-security
  middleware bans the IP (previously the cluster endpoints recorded nothing).

## 2.4.1

### Fixed
- **NestJS 11 SPA-fallback regression** — the ServeStaticModule `exclude`
  patterns used the old path-to-regexp `(.*)` capture, which throws under
  path-to-regexp v8 (bundled with NestJS 11): every request that fell through to
  the SPA fallback (dashboard deep-link reloads, unmatched `/api` paths, the
  cluster `/nodes` view) returned **500** instead of serving `index.html` / a
  clean 404. Rewrote the excludes to the v8 named-wildcard spelling
  (`/api/*splat`, `/rtc/*splat`, …). Discovered on the 2.4.0 rollout.

## 2.4.0

### Added
- **Transcription plugin (#10)** — VOD → mp3 → faster-whisper (OSS) or OpenAI →
  SRT uploaded to the app's S3 + transcript stored on the VOD, with per-track
  speaker split. Dashboard transcript panel + "Download SRT".
- **StreamHub MCP server** (`mcp-server/`) — the `/api/v1` surface as 47 MCP
  tools so an AI client (Claude Desktop/Code) can operate a StreamHub instance;
  destructive ops hidden unless `--allow-destructive` + `confirm:true`.
- **Documentation site** — `docs.streamhub.studio` (+ `/docs`) renders the
  `https://streamhub.studio/docs/` tree (CommonMark, sidebar, search); `php artisan docs:sync`.
- **Downloadable example bundles** — every app example as a self-contained,
  configurable bundle (`edit config.js`, host anywhere) + `/apps/:app/examples`
  list/zip download.
- **Recording on/off toggle** per app (dashboard VODs tab) — master switch over
  `config.recording.enabled`.
- **Delete-app danger zone** in the app System tab (typed-name confirmation).
- **StreamHub Agent** (separate repo) — CCTV edge agent with detection as a mode
  (`remote | edge | off`); one-command Linux/ARM installer.
- **n8n automation workflows** (build platform/agent/docs, clean GitHub push,
  IMAP + ticket chatbots) — documented in operations/N8N-WORKFLOWS.md.

### Fixed
- **WebRTC adaptor validated** — 0 → 92 tests; fixed `play_finished` never firing
  and `data_channel_opened` double-firing (AntMedia drop-in contract).
- **Rendition ladder can be cleared** — deleting all adaptive resolutions no
  longer 400s (`@ArrayMinSize` removed) and no longer silently reverts to the
  defaults on read; clearing the ladder now disables adaptive delivery.

## 2.3.0

Large stabilization + feature wave.

### Added
- **LiveKit native features**: rooms/moderation API (kick/mute), data messages
  (real-time `scheduled-live` push), room/participant metadata, auto-record on
  room start, track/audio-only egress (no headless Chrome), config-driven
  adaptive stream + dynacast, SSRF-guarded URL-pull ingress.
- **In-app SQLite backups** — `/system/backups`: versioned + gzipped snapshots,
  7-day retention, guarded restore (integrity-check + auto safety copy).
- **ISO-readiness** — append-only hash-chained **audit trail** (`/system/audit`)
  + `/system/compliance` posture (ISO 27002 §8 evidence); dependency scanning in
  CI (npm high advisories 10 → 0).
- **RTMPS ingest** — opt-in TLS front (`:1936`), `rtmps_url` surfaced on the
  ingress API. Validated end-to-end on a real box.
- **OS-tuning reporter** (`/system/os-tuning`) + **30-day resource-usage history**
  (`/system/metrics/history`, CPU/RAM/net/disk dot charts).
- **DRM** implementation-ready (DrmProvider interface, CENC/CBCS packaging seam,
  `features.drm`, off by default).
- **Next-gen EDGE-via-GRID** plugin contract (`worker.placement: local|grid`) +
  Vision/Grid/Babel/semantic-search manifest scaffolds.
- **Debian 12/13** support in the installer (in addition to Ubuntu).
- **StreamHub Agent** (separate repo) — a C edge agent for CCTV cameras that
  streams to a StreamHub instance with **remote** AI detection.
- Docs: AWS cluster guide, OpenAPI snapshot + Postman, ffmpeg-slim analysis,
  OWASP 2025 + ISO readiness, managed-hosting billing/pricing design.

### Changed
- **Node 20 → 24 LTS**; **NestJS 10 → 11**; `nodemailer` → 9 (SMTP-injection fix).
- Public user registration **off by default** (`STREAMHUB_PUBLIC_REGISTRATION`).
- Security P0 class closed + regression-locked: SSRF egress guards
  (callbacks/S3/MQTT), `X-Forwarded-For` trust fix, signed playback URLs,
  multi-tenant isolation ordered before the api_token bypass.

### Security
- `LICENSE` AGPL-3.0 at repo root; per-package license fields.
- The customer-panel instance-provisioning flow is disabled by default
  (`STREAMHUB_PROVISIONING_ENABLED`) until the owner-supervised launch is signed
  off.

## 2.2.0

- Single-app packaging (`/opt/streamhub`, `streamhub` CLI, systemd unit),
  versioned release pipeline, upgrade + migration in `install.sh`.
- `scheduled-live` plugin (9th). Observability connect guide.
- Cluster join / Redis reachability fixes; anonymous install telemetry.
