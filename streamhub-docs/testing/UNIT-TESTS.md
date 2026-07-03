# StreamHub — Unit & Integration Test Catalogue

**991 tests, 80 suites, all green** (jest run 2026-07-03). Run with `npm test`
from `streamhub-core/` (jest + ts-jest, Redis/BullMQ/LiveKit/S3/MQTT mocked, no
infra). This file catalogues the documented suites by module and states the
invariants each one locks down — suites added by later waves may not be
catalogued yet (the table below is the documented subset, not the full run).

| # | Suite | Tests | Kind |
|---|-------|------:|------|
| 1 | `modules/apps/apps.service.spec.ts` | 58 | unit |
| 2 | `modules/auth/auth.service.spec.ts` | 45 | unit |
| 3 | `modules/auth/password.util.spec.ts` | 7 | unit |
| 4 | `modules/authz/authz.service.spec.ts` | 14 | unit |
| 5 | `modules/authz/permission.guard.spec.ts` | 15 | unit |
| 6 | `modules/callbacks/callbacks.service.spec.ts` | 16 | unit |
| 7 | `modules/db-admin/db-admin.controller.spec.ts` | 11 | unit |
| 8 | `modules/livekit/webhooks.controller.spec.ts` | 20 | unit |
| 9 | `modules/quotas/quotas.service.spec.ts` | 14 | unit |
| 10 | `modules/recording/recording.service.spec.ts` | 31 | unit |
| 11 | `modules/recording/vods.repository.spec.ts` | 16 | unit |
| 12 | `modules/s3/s3.service.spec.ts` | 26 | unit |
| 13 | `modules/samples/samples.service.spec.ts` | 23 | unit |
| 14 | `modules/streams/streams.service.spec.ts` | 29 | unit |
| 15 | `modules/system/gpu.service.spec.ts` | 7 | unit |
| 16 | `modules/system/hwaccel.service.spec.ts` | 16 | unit |
| 17 | `modules/tenancy/tenancy.service.spec.ts` | 21 | unit |
| 18 | `shared/db/db-maintenance.service.spec.ts` | 6 | unit |
| 19 | `test/auth-tenancy.e2e-spec.ts` | 18 | e2e |
| 20 | `test/config-samples-apps.e2e-spec.ts` | 26 | e2e |
| 21 | `test/smoke.e2e-spec.ts` | 2 | e2e |
| 22 | `test/streams.e2e-spec.ts` | 8 | e2e |
| 23 | `modules/mqtt/mqtt.service.spec.ts` | 18 | unit |
| 24 | `modules/mqtt/latency-monitor.service.spec.ts` | 8 | unit |
| 25 | `modules/callbacks/callbacks.mqtt-tap.spec.ts` | 5 | unit |
| 26 | `modules/apps/apps.mqtt-config.spec.ts` | 8 | unit |
| 27 | `modules/plugins/plugin-worker.events.spec.ts` | 7 | unit |
| | **Total (catalogued)** | **475** | |

Grouped by concern below.

---

## Auth / Tenancy / Authz / Quotas (144 tests)

### `auth.service.spec.ts` — 45
The credential resolver: signup/login, `sk_` API tokens, IP whitelisting, login
JWTs and the public-path bypass.

Invariants:
- **Signup** creates user + team + owner membership and mints a valid JWT;
  duplicate email rejected; a PENDING (invited, password-less) user can complete
  signup keeping their team; refuses when `STREAMHUB_JWT_SECRET` is unset;
  cannot sign up as the configured `ADMIN_USER` email.
- **Login** validates password; rejects wrong/unknown/pending; **break-glass
  admin** (`ADMIN_USER`/`ADMIN_PASS`) mints an admin JWT (`sub=admin`) and is
  only enabled when creds are set.
- **`sk_` tokens**: a global token → superadmin/global (back-compat); an
  app-scoped token → non-superadmin service (`scope=app`); unknown/revoked/
  missing rejected; `last_used_at` touched on success.
- **IP whitelist**: exact + CIDR match, rejects outside, honours
  `X-Forwarded-For` over socket IP, normalises IPv4-mapped IPv6, empty
  whitelist = no restriction.
- **Login JWTs** resolve user → tenant + role; admin JWT → superadmin (never
  lockable, even with `ADMIN_USER` unset); expired / wrong-secret / unknown-sub
  rejected.
- **Public-path bypass** (`it.each`): `/api/v1/play/**`, `/embed`, health/docs
  paths resolve to `PUBLIC_CONTEXT`; a non-public path does not.
- **Token management**: plaintext returned once, only a hash stored; `appId`
  required for `scope=app`; rejected on global tokens; list never leaks the
  hash; revoking a non-existent token rejected.

### `password.util.spec.ts` — 7
scrypt hashing: self-describing `scrypt$N$r$p$salt$hash` format; fresh random
salt per call; verify accepts correct / rejects wrong; **never throws** on
malformed or foreign hashes; rejects same-length tampered content; documents the
empty-hex edge case.

### `tenancy.service.spec.ts` — 21
- **Bootstrap** (`onModuleInit`): ensures the platform tenant + effectively
  unlimited quota; idempotently adds `users.password_hash`/`status` columns;
  mirrors break-glass `ADMIN_USER` as a superadmin owner of platform; creates no
  admin when unset; **never throws out of `onModuleInit`** even if seeding
  hiccups.
- **Users**: stable `usr_` ids; case-insensitive email lookup; `setPassword`
  flips status to active; `ensureUser` idempotent upsert preserving email.
- **Teams/quotas**: `createTeam` mints `tnt_` id + seeds a free-plan quota;
  `ensureTenant` idempotent; unknown ids → null.
- **Memberships**: role set/read; idempotent upsert that upgrades role on
  conflict; `primaryMembership` prefers the owner team; `listMembers` flattens
  membership+user oldest-first.
- **App→tenant lookups** resolve; unknown app → null.

### `authz.service.spec.ts` — 14
Casbin RBAC verdicts + data-scope:
- Role capabilities: owner full control; viewer read-only; editor operates media
  but cannot delete the app or touch tenant/token admin; service role broad
  allow; **superadmin is NOT in the policy (it bypasses in the guard)**; roles
  are tenant-independent (domain `*`); **falls open (true) when the enforcer
  never initialised**.
- `appBelongsToTenant()`: true for own app, false cross-tenant, superadmin
  passes any, unscoped credential not blocked, unknown app / NULL-tenant app not
  blocked (handler 404s normally).

### `permission.guard.spec.ts` — 15
The `@RequirePermission` guard across `AUTHZ` modes:
- passes handlers with no decorator; passes when `authCtx` absent (back-compat).
- **mode=off** skips; **mode=log** (default) allows-but-logs a would-be denial;
  **mode=on** denies a viewer create (403), allows a viewer read, denies an
  owner on a cross-tenant `:app` (data-scope), allows in-tenant.
- **INVARIANT** (`it.each(['off','log','on'])`): platform-owner credentials and
  app-scoped `api_token` are never blocked — even cross-tenant in mode=on.

### `quotas.service.spec.ts` — 14
- `enforceCreateApp`: mode=on rejects with **429** at/over quota; mode=log
  allows+logs; mode=off not checked; allowed while under; `-1` = unlimited.
- **INVARIANT**: superadmin / api_token / unscoped / missing-context are never
  quota-limited.
- `enforceConcurrentStreams`: rejects at the active-stream limit; ended streams
  do not count.
- `getUsage`: reports limits, counts, per-metric `exceeded` flags; default
  quotas for unknown tenant; honours `-1`.

---

## Streams — including the duplicate-stream regression (29 + 8 e2e)

### `streams.service.spec.ts` — 29
The stream-tracking core. **The canonical key is `${room}/${identity}`** — the
single key shared by the webhook path and the reconcile path. This is the fix
for the over-counting bug.

- **`canonicalStreamId` invariant**: id is exactly `${room}/${identity}`.
- **upsert**: one active row per new canonical stream; idempotent on the
  canonical key (`ON CONFLICT` → single row); **never downgrades an ingress type
  back to webrtc** (webhook order-independent); reactivates an ended row;
  NotFound for unknown app.
- **REGRESSION — one RTMP ingress must be ONE stream, not three**:
  `ingress_started` + `participant_joined` + reconcile collapse into a **single
  active row**; reconcile alone (no webhook) creates the same canonical row.
  *(This is the guard against the bug where subscribers/participants inflated the
  stream count.)*
- **list() reconcile — discovery + dedupe**: distinct live publishers, no
  duplicate ids; a viewer (non-publisher) never creates a stream; pre-existing
  webhook row + reconcile discovery of the same publisher stays one row; only
  active rows returned.
- **reconcile prune**: ends aged active rows whose participant stopped
  publishing or whose room is gone; does NOT prune within the grace window; does
  NOT prune when the participant list can't be fetched (state unknown); no-op
  when LiveKit unreachable; ends legacy non-canonical rows (id without `/`);
  when no `roomClient` configured, `list()` returns active rows untouched.
- **ws-mjpeg exemption (ESP32-WS-INGEST)**: reconcile NEVER prunes
  `type='ws-mjpeg'` rows (their liveness is owned by the ws-ingest gateway, not
  LiveKit) while a normal aged rtmp row in the same run IS pruned; upsert never
  downgrades `ws-mjpeg` back to `webrtc`.
- **get()**: null for unknown; returns record; exposes viewer count (**real
  subscribers only**) when `viewerCounter` enabled, hides it otherwise.
- **stop()**: NotFound unknown; disconnects participant + marks webrtc ended;
  no LiveKit teardown for an already-ended stream.
- **snapshot() guards**: blank room → 400; unknown app → 404.

### `streams.e2e-spec.ts` — 8
HTTP contract over a real in-memory Nest app:
- `GET /apps/:app/streams` wraps in `{ data: [...] }`, reflects upserted active
  streams, 401 unauthenticated, 404 unknown app.
- `GET /apps/:app/streams/:id` wraps in `{ data }`, 404 unknown id.
- `DELETE /apps/:app/streams/:id` stops (204) and marks ended so it drops out of
  the list; 404 stopping an unknown stream.

---

## WS ingest — ESP32 direct MJPEG (ESP32-WS-INGEST.md F1) — 4 suites

All in `modules/ws-ingest/`, no sockets/HTTP server: the gateway logic is
exercised through the `WsLikeSocket` / req-res seams with hand-rolled fakes,
per the no-infra testing rule.

### `frame-hub.spec.ts` — 8
The in-memory last-frame store + fan-out (§5 of the design):
- depth-1 buffer (only the LAST frame retained per app/room);
- new subscriber immediately receives the last frame;
- per-viewer drop: a not-ready viewer is skipped (dropped++) while others still
  receive — no head-of-line blocking; a viewer whose `send()` throws never
  breaks the loop;
- slot lifecycle: deleted only when no viewers AND no publisher; viewer
  counts/slot info for metrics.

### `ws-ingest.service.spec.ts` — 30
Handshake auth + protocol limits + lifecycle with FAKE sockets and fake timers:
- **handshake**: valid `wsk_` key (query or `Authorization: Bearer`) → `ready`
  (room/streamId/maxFps/maxFrameBytes/idleTimeoutSec) + `streams.upsert(type
  'ws-mjpeg')` + `stream_started`; missing/unknown/revoked key, unknown app,
  room mismatch → close **4401** with NO registration; `ws_ingest.enabled:
  false` → **4403**; quota exceeded → **4403**; `max_cameras` cap → **4403**;
  per-IP handshake rate limit → **4429**.
- **duplicate key**: the NEW connection wins; the old socket gets **4409** and
  its close does NOT end the stream row nor clear the hub publisher.
- **limits**: frame > maxFrameBytes → error + **4413**; fps above the cap →
  silent drop (bucket refills after 1 s); non-JPEG garbage dropped, reincidence
  → close 1003; `stats` text lands in `streams.last_stats_json`; malformed text
  ignored.
- **lifecycle**: idle 30 s → **4408** + `streams.end` + `stream_ended`; frames
  keep it alive; 2 lost pongs → terminate; disconnect → end + callback +
  publisher cleared; boot cleanup ends stale active ws-mjpeg rows ONLY.
- **viewers/gate**: WS viewer receives fan-out, saturated buffer → drop,
  disconnect unsubscribes; `publicPlayback: false` without token → 4401; a real
  LiveKit subscribe token opens ONLY its own room (AccessToken/TokenVerifier,
  pure JWT — no network).
- **provisioning**: mint → `wsi_`/`wsk_` prefixes + namespaced room + URLs, and
  the minted key authenticates end-to-end; listKeys reports live state; revoke
  closes the active camera and the key stops authenticating; liveInfo flips
  with the camera lifecycle and 404s when publicPlayback is off.

### `live-http.spec.ts` — 9
The `/live/<app>/<room>/mjpeg` + `frame.jpg` express layer over req/res fakes:
- mjpeg: `multipart/x-mixed-replace; boundary=frame` headers, immediate last
  frame, streaming fan-out with per-part `Content-Length`;
- backpressure: while `write()` returns false frames are skipped until `drain`
  (never queued, no backlog replay); client disconnect unsubscribes;
- frame.jpg: image/jpeg + no-store, 404 when the room has no frame; short room
  names get namespaced (and namespaced ones pass through);
- gates: unknown app / bad path → terminal 404 JSON; `publicPlayback: false`
  without (or with garbage) token → 401.

### `ws-keys.controller.spec.ts` — 8
Provisioning REST contract (`/apps/:app/ws-ingest`): POST mints `wsk_` with the
quota pre-flight (429 propagates, nothing minted) + custom identity + URLs; GET
lists keys with live state and credentials (RTMP-listing parity); DELETE
revokes (404 unknown); `GET live/:room` (public) flips with the hub publisher.

---

## Recording / VODs / S3 (73 tests)

### `recording.service.spec.ts` — 48
The recording lifecycle and VOD state machine:
- **start()**: rejects missing room / recording-disabled; happy path launches
  egress, persists a recording VOD, returns a handle; `streamId` defaults to
  room; participant mode egresses the participant whose identity == `streamId`;
  a `startEgress` failure is wrapped and persists no VOD.
- **split/snapshot normalization**: allowed `splitMinutes` tags the VOD as a
  part (`p000`); out-of-set clamps to 0 (continuous); allowed `snapshotSeconds`
  attaches an image output; out-of-set clamps to 0.
- **stop()**: by numeric VOD id (status unchanged — the webhook drives upload)
  or by egress id; NotFound unknown; wraps a `stopEgress` failure.
- **record-live**: `startForStream` records the resolved room; `stopForStream`
  stops it / NotFound when nothing in progress.
- **onEgressEvent()**: ignores progress events; no throw on unknown egress id;
  marks VOD failed + fires `recording_failed`; **complete** uploads mp4 +
  snapshot, marks ready, fires `vod_ready` + `recording_ready`; marks failed if
  the local file is missing; **an upload failure marks failed and KEEPS the
  local file (SPEC §8.4)**; deletes the local file after a successful upload when
  configured.
- **getVod() URL selection**: prefers the deterministic public URL when
  `s3.publicUrl` is set; falls back to presigned; no URLs while not ready;
  degrades to null URLs when presigning fails; NotFound missing VOD; exposes
  `variants` + `adaptive` (master/renditions/alternates, ordered) with
  public-base URLs, presigned fallback for whole-file kinds and `url: null`
  for renditions without a public base.
- **deleteVod()**: deletes the row + both S3 objects (file + snapshot) + the
  local file; reports `s3Deleted=0`/`localDeleted=false` when there are no
  objects; NotFound missing VOD; **cascades every variant S3 object**
  (master + rendition playlists + segments + webm) and the `vod_variants` rows.
- **post-transcode hand-off**: DEFAULT (transcoding disabled) never enqueues a
  transcode job and keeps the delete-local behaviour; opt-in enqueues
  `{sourcePath, deleteSourceAfter}` AFTER the VOD is ready and DEFERS the local
  delete to the transcode job (source + `local_path` survive).

### `vod-transcode.service.spec.ts` — 13
The ffmpeg post-transcode pipeline (feature transcoding-adaptive-vod): real
temp DB + real Vods/VodVariants repositories; ffmpeg helpers
(`transcodeHlsRendition`/`transcodeWebmVp8`) and `probeMedia` jest-mocked
(write realistic playlist/segment/webm files); inline (queue-less) processing.
- **planFor()/needed()**: `transcoding.enabled` master switch gates everything
  (even with vp8 + adaptive configured); `h264+vp8` → webm only; explicit
  `vod_renditions` ladder used verbatim; empty ladder derived from
  `webrtc.layers` with default bitrates (720→2800, 480→1400, 240→500).
- **adaptive pipeline**: N rendition variants + master row; playlists, segments
  and master uploaded (`hls/<base>/...`); master playlist content carries
  BANDWIDTH/RESOLUTION per rendition + rendition URIs; rendition rows store the
  playlist key + `segmentKeys`; metatags get `hlsMasterKey`;
  `vod_variants_ready` fired once; the transcode workdir is cleaned.
- **degradation**: a failed rendition is skipped (master references the rest);
  everything failing → no rows, error logged, VOD stays `ready`; missing
  source logged, nothing generated.
- **h264+vp8**: webm alternate uploaded as `video/webm` + `alternate` row; both
  pipelines compose (master + rendition + alternate).
- **source lifecycle**: `deleteSourceAfter=true` removes the source and nulls
  `vods.local_path`; false keeps both.

### `vod-variants` (covered inside the two suites above)
Repository exercised against the real migrated `vod_variants` table (insert /
ordered listByVod / deleteByVod) via the service specs.

### `vods.repository.spec.ts` — 16
The SQLite persistence layer:
- insert + findById maps snake_case → camelCase; null for missing.
- update is a partial patch (writes only provided columns; coerces `undefined`
  → null; no-op on empty patch; round-trips `metatags` JSON).
- list orders by id DESC + honours limit/offset; empty array for an empty app.
- `findByEgressId` via `json_extract` on `metatags.egressId`; returns the newest
  match when the egress id repeats (split parts).
- `findActiveByStream` returns the latest recording/uploading VOD, ignores
  ready/failed, scopes to the stream.
- delete removes / no-op for missing.

### `s3.service.spec.ts` — 26
Object storage adapter (prefix assembly, presign, delete, exists, public URLs):
- **key assembly**: prepends the configured prefix; does NOT double-prefix an
  already-prefixed key; respects the slash boundary (no prefix look-alike
  match); strips leading slashes with an empty prefix; returns size, canonical
  URL and a quote-stripped ETag; guesses content-type from extension; wraps a
  missing local file / a directory source / an SDK failure in a controlled
  exception (**no secret leak**).
- **config validation**: throws when bucket missing / credentials unresolved.
- **presignGet**: applies the prefix; default 1h TTL; defaults 1h for
  non-positive/non-finite; caps at the SigV4 max of 7 days; floors fractional
  seconds.
- **delete** idempotent (swallows NotFound / 404 via `$metadata`), re-throws
  non-404.
- **exists**: true on HEAD ok, false on not-found, re-throws unexpected.
- **publicUrlFor**: AWS virtual-host, MinIO path-style (`forcePathStyle`),
  Wasabi custom-endpoint virtual-host; URL-encodes each path segment.

---

## Config / Samples / Apps (58 + 23 + 26 e2e)

### `apps.service.spec.ts` — 58
The largest suite — app CRUD, the config editor, backups/revert, hot-reload and
masked S3 config.
- **create** scaffolds dirs + `config.yaml`, returns the record;
  **INVARIANT: a freshly created app is homed to the platform tenant**; defaults
  `displayName`/`roomPrefix` to the name; lowercases `roomPrefix`; writes
  `config.yaml` as a valid mapping with **secret refs, never raw creds**;
  `it.each` slug validation; duplicate name → 409 (case-insensitive).
- **get/list**: null for missing; sorted by name asc.
- **delete**: removes the registry row but **preserves local files by default**;
  purges the app dir when `deleteVods:true`; NotFound missing.
- **config editor** (raw GET/PUT + dry-run):
  - `putRawConfig` persists valid YAML and hot-reloads; soft warning when
    `room_prefix` omitted; warns about inline `s3.key/secret` and ignores them
    when resolving.
  - **INVARIANT: a YAML parse error yields 400 and does NOT touch the file**;
    a non-mapping top level → 400, no write; a config whose name mismatches the
    app → 400, no write.
  - `dryRunRawConfig` reports valid + diff without writing; reports
    `valid=false` + error **without throwing** on bad config; **never writes**.
- **backups + revert**: a PUT backs up the previous config (listable, newest
  first); **never keeps more than 20 backups**; reads a backup verbatim; revert
  restores a prior config verbatim (and is itself reversible); invalid/unknown
  backup ids → 400/404.
- **reload**: re-syncs the registry row from edited YAML; **hot-reload re-inits
  secrets + the S3 client cache**; `reloaded=false` + warning when unreadable.
- **S3 config (masked)**: "not configured" before creds; `setS3` persists the
  non-secret block; **credentials masked in the response and NEVER written to
  the yaml**; enabling a `public_url` without `confirmPublic` → 400; with
  `confirmPublic:true` flags `publicVods` + a warning; clearing an existing
  `public_url` needs no confirm.

### `apps.transcoding-config.spec.ts` — 6
The per-app `transcoding:` config block (feature transcoding-adaptive-vod):
- **INVARIANT: a NEW app has transcoding DISABLED** (`transcoding.enabled:
  false` = passthrough, `encoding: h264`, no VOD ladder) and the block is
  persisted snake_case in `config.yaml`.
- **updateConfig round-trip**: enabling + `h264+vp8` + adaptive ladder persists
  to disk (`bitrate_kbps`) and resolves back camelCase (ladder sorted
  highest-first).
- **back-compat**: a legacy yaml WITHOUT the block resolves `enabled` from
  `rtmp.transcode` (true stays transcoding, false stays off).
- **sanitization**: unknown encodings fall back to `h264`; invalid/duplicate
  renditions dropped/deduped.

### `transcoding.service.spec.ts` — 9
The transcoding config facade (`GET/PATCH /apps/:app/config`) + ingress gate:
- **getConfigView** surfaces the `transcoding` block (enabled/encoding/
  vodAdaptive/vodRenditions + hwaccel/hwaccelResolved); 404 unknown app.
- **updateConfig** maps `transcodingEnabled`/`encoding`/`vodAdaptive`/
  `vodRenditions` onto an `AppConfig.transcoding` patch; a partial patch
  preserves the untouched fields; unrelated PATCHes never touch the block.
- **INVARIANT: `shouldTranscodeIngress` requires the master switch** — the
  default (disabled) config is passthrough even with `rtmp.transcode: true`;
  enabled + rtmp.transcode → transcodes; enabled without rtmp.transcode → no.

### `samples.service.spec.ts` — 23
The per-app sample/player-page generator:
- **generate** writes the standard sample set; resolves `{{APP}}`/`{{ROOM}}`
  placeholders; NotFound missing app.
- **list** returns generated files (sorted) with embed URLs + `generated=true`;
  flags non-template and legacy publish/play/embed pages as `generated=false`.
- **read/write** round-trips; can create a brand-new sample; `it.each` guards on
  unsafe filenames; NotFound missing app.
- **per-app isolation**: editing/regenerating one app's sample never touches
  another app's copy; a generated sample is scoped to its own app dir.

### `config-samples-apps.e2e-spec.ts` — 26
The same surface over HTTP: apps CRUD (incl. 400 bad slug, 409 duplicate, 404),
config editor (`/config/raw` GET/PUT, `/validate` dry-run, `/backups` list/read/
revert, `/reload`), masked `/s3` (incl. the `confirmPublic` gate), and samples
(list/read/write/regenerate + the cross-app isolation invariant).

---

## Callbacks / Webhooks / MQTT (16 + 5 + 18 + 8 + 8 + 7 + 20)

### `callbacks.service.spec.ts` — 16
The signed outbound webhook dispatcher:
- **signed happy path**: POSTs once to the configured URL; **signs the exact
  body with HMAC-SHA256 as `sha256=<hex>`**; emits the wave-3 envelope
  `{ id, event, app, room, ts, timestamp, data }`; sets tracing/content headers
  (event, delivery, timestamp); `room` is null when absent/non-string; forwards
  **any** event name in the taxonomy verbatim.
- **does not fire without a URL**: skips (no fetch) when URL empty / whitespace /
  block missing; does not throw or fetch when `getConfig` throws.
- **unsigned dispatch** (URL but no secret): still POSTs, omits the signature
  header.
- **delivery loop**: logs "delivered" once on 2xx (no retry); does NOT retry a
  non-retryable 4xx (400); retries a 500 up to `MAX_ATTEMPTS` then gives up
  (**never throws**); retries a 429; retries on a thrown network error and never
  rejects.

### `callbacks.mqtt-tap.spec.ts` — 5
The MQTT fan-out tap inside the callbacks funnel:
- every dispatched event is mirrored to `MQTT_SERVICE.publishEvent` with the
  same app/event/payload while the webhook POST still fires;
- MQTT fan-out happens **even without a webhook URL** and when the callbacks
  config load fails (the sink does its own gating);
- an exploding MQTT sink never breaks webhook delivery; the sink is optional
  (bare construction still works).

### `mqtt.service.spec.ts` — 18 (modules/mqtt)
The per-app MQTT client manager + publisher, with the `MQTT_CLIENT_FACTORY`
seam faked (**nothing can open a socket**):
- publishes the exact `{event, app, timestamp, data}` envelope (no extra keys)
  to `<prefix>/<category>/<event>`; category routing for vod/plugin/alert/
  interaction/connection; qos honoured; credentials passed to the factory;
  empty prefix falls back to `streamhub/<app>`.
- **disabled / empty URL / app gone → no client is ever created**; turning
  mqtt off drops the live client.
- `events` list filters publishes; `['all']` passes everything.
- config fingerprint change (url/tls/creds) → old client cleanly ended, new
  one built; `disconnectApp` ends the client and the next publish reconnects.
- reconnect backoff: `reconnectPeriod` doubles per close, capped at 30 s,
  reset on connect; broker errors logged once per disconnected episode.
- log forwarding: gated on `logs.enabled` + minimum level; **source `mqtt` is
  skipped (loop guard)**.
- never throws: factory explosion and publish explosion are both swallowed.

### `latency-monitor.service.spec.ts` — 8 (modules/mqtt)
The stream latency monitor with a fake probe:
- breach → exactly ONE `stream.latency_high` through the callbacks funnel with
  `{room, rttMs, thresholdMs, metric, participants, publishers}`; latched while
  high (no duplicates); recovery → `stream.latency_recovered`;
- a re-breach inside `cooldownSeconds` is suppressed, fires again after;
- disabled config → the probe is never called; per-app `intervalSeconds`
  pacing; failed probes change no state; **never throws** on probe/config
  failures.

### `apps.mqtt-config.spec.ts` — 8 (modules/apps)
The `mqtt:`/`latency_alert:` config machinery (real temp DB + SecretsStore):
- defaults resolve safe (disabled, `streamhub/<app>` prefix, events `['all']`,
  latency alert off with 1000/60/10);
- **the broker password never lands in config.yaml** — only the
  `password_env` ref; the value goes to `data/secrets.json` via `setMqtt` and
  via `updateConfig(mqtt.password)`;
- masked on read (`getMqtt`), resolved for internal consumers (`getConfig`);
  omitting `password` keeps the stored one; junk sanitized (qos→0,
  empty events→`all`, bad level→`info`); raw editor warns on an inline
  `mqtt.password`; 404 on unknown apps.

### `plugin-worker.events.spec.ts` — 7 (modules/plugins)
Worker lifecycle → callbacks funnel (fake child, no real process):
- `plugin_worker_started` on start (with pid); `plugin_worker_stopped` on
  clean exit AND on manual stop (single emit site — the exit handler);
- `plugin_worker_error` on crash exit, on child 'error' (deduped when both
  fire) and on spawn failure; the callbacks dependency is optional.

### `webhooks.controller.spec.ts` — 20
The LiveKit webhook ingest → stream tracking + callback fan-out:
- **signature**: acks `{ data: { received: true } }` when valid; **401 and
  routes NOTHING** when `receiveWebhook` rejects.
- **forwarding** (`it.each(FORWARDED)`): forwards mapped events verbatim to
  dispatch; does NOT forward unmapped LiveKit events (e.g. `track_muted`); never
  fires a callback when no app resolves from the room; builds flat, JSON-safe
  `data`.
- **participant events**: upserts a webrtc stream + dispatches both
  `stream_started` and `participant_joined`; marks an INGRESS-kind participant
  as `rtmp`; skips hidden (QC/recorder) participants for business but still
  forwards the raw event; `stream_ended` on `participant_left`.
- **ingress events**: upsert + `stream_started` when the identity is known;
  **terminates an unauthorized RTMP ingress and emits `stream_ended`
  (`unauthorized_rtmp_password`)**; `stream_ended` on `ingress_ended`.
- **egress events**: advances the recording flow + forwards the raw event.
- **resilience — always ack 200**: still acks when `streams.upsert` throws and
  when `callbacks.dispatch` throws.
- **e2e**: `POST /api/v1/webhooks/livekit` is a public route that rejects an
  unsigned/invalid webhook with 401.

---

## System — GPU / HW accel / Settings

### `gpu.service.spec.ts` — 7
GPU probe: reports `none`/`available:false` with no `nvidia-smi` and no
`/dev/dri` (**never throws**); detects NVIDIA from `nvidia-smi` CSV; falls back
to VAAPI on render nodes; prefers NVIDIA over VAAPI; honours `GPU_DISABLE=true`;
caches + re-probes on `refresh()`; doesn't throw on malformed output.

### `hwaccel.service.spec.ts` — 16
The transcoding accel selector:
- get/set mode: defaults to `auto`; honours `TRANSCODING_HWACCEL`; persists a
  per-app mode via the sidecar; rejects invalid; falls back on a corrupt
  sidecar.
- **resolve**: `cpu` ⇒ cpu regardless of GPU; `gpu`+available ⇒ gpu;
  `gpu`+no-GPU ⇒ cpu fallback; `auto`+GPU ⇒ gpu (vaapi); `auto`+no-GPU ⇒ cpu;
  **degrades to cpu (never throws) when the GPU status rejects**.
- `egressEncoding` / `ingressVideo` return H.264 GPU options when GPU chosen, no
  options on CPU (preserves default behaviour); `recordUsage` forwards the accel
  path to the metrics counter.

### `settings.service.spec.ts` — read-only server settings (#16)
Builds the effective config from `ConfigService` (+ DB/runtime) with EVERY secret
redacted. **Shape**: every group (core/auth/livekit/cluster/metrics/storage/
versions/runtime/ports) + a per-group `guidance` array; ports are the fixed
well-known values. **Redaction (the load-bearing invariant)**: pinned
distinctive secret env values (`…_NEVER_EXPOSE`) never appear anywhere in the
serialized payload, the secret KEY names (`jwtSecret`/`apiSecret`/`adminPass`/
`clusterToken`/…) are absent from the tree, and the Redis password is stripped to
a bare `host:port` (even for an odd URL). Secrets surface only as `…Set` booleans
/ `apiKeyMasked`; `authzEnforce` is shown verbatim (a mode, not a secret).

### `system.controller.spec.ts` — `GET /system/settings` scope gate
Delegates to `SettingsService` and enforces the same global-scope rule as
cluster/db-admin: 200 (enveloped) for global-scope or superadmin, **403** for an
app-scoped non-superadmin, no-op in dev (no auth bound). The 401-anonymous case
rides on the global Bearer guard and is covered in
`test/system-settings.e2e-spec.ts`.

---

## DB maintenance / admin (6 + 11)

### `db-maintenance.service.spec.ts` — 6
`appHealth()` / `globalHealth()` report path, sizes, page/freelist counts,
fragmentation and tables; `optimizeApp()` runs the full tune-up + returns
before/after sizes; `purgeAppStreams()` deletes all stream rows + returns the
count; `purgeAppLogs()` deletes only the app's `server_logs` (scoped by
`app_id`), 0 for unknown app.

### `db-admin.controller.spec.ts` — 11
- health/optimize passthrough to the maintenance service.
- **purge()**: rejects without `confirm:true`; scope `logs` touches only logs;
  scope `vods` **cascades each VOD via `recording.deleteVod`** and accumulates
  counters; scope `all` cascades vods + purges streams + logs; **keeps draining
  pages until `listVods` returns empty** (the VOD-delete cascade / pagination
  invariant).
- `systemHealth()` global-scope gate: allows global-scope or superadmin, rejects
  an app-scoped credential, allows when no auth is bound (dev/skeleton).

---

## Auth/Tenancy e2e (18) + Smoke (2)

### `auth-tenancy.e2e-spec.ts` — 18
End-to-end over the real Nest app: signup/login/`/auth/me` (incl. short-password
400, duplicate 400, wrong-password 401, missing/garbage Bearer 401); API tokens
(`/tokens`) with `sk_` back-compat (global token → superadmin/global; list never
leaks the hash; create-then-revoke stops authenticating); teams & tenant usage
(`/teams/mine`, owner can invite, viewer cannot (403), a user may read only its
OWN tenant — 403 cross-tenant). **INVARIANT block (AUTHZ=on)**: the `sk_` token
and admin JWT are never blocked — both reach a `@RequirePermission` route
(`usage:read`) and are NOT 403, and the admin JWT can read `/teams/mine` on the
platform tenant.

### `smoke.e2e-spec.ts` — 2
`GET /api/v1/health` returns 200 + `up:true` (public, no auth); the isolated DB
helper opens a fresh, migrated `streamhub.db` per suite.

---

## Fase-0 security (M2 / M3 / M6 / M8)

New + updated suites that lock down the Fase-0 hardening. Run the full suite in
BOTH modes to exercise the phased switch: `npm test` (harness default `log`) and
`STREAMHUB_AUTHZ_ENFORCE=on npm test`.

### `authz.service.spec.ts` (updated) — fail-closed
`can()` now fails **closed** (deny) when the enforcer is unavailable or
`enforce()` throws AND `STREAMHUB_AUTHZ_ENFORCE=on`; it still fails **open**
(allow, back-compat) in `log`/`off`. Two mode-parametrised cases pin both the
dead-enforcer and the enforce-throws paths.

### `permission.guard.spec.ts` (updated) — M2 app-scoped isolation
New `M2 — app-scoped token isolation` block: an app-scoped token (`scope:'app'`)
is **403** on another app in `on` (by APP ID, so it holds even when two apps
share a tenant), **allowed** on its own app, isolation also covers the `:name`
param (config/s3 routes), only logs `WOULD-DENY` in `log`, does not block an
unknown route app, and a GLOBAL token still reaches any app (golden rule). This
REPLACES the old "app-scoped api_token bypasses even a cross-tenant app" case
that asserted the vulnerable fail-open behaviour.

### `auth.service.spec.ts` (updated) — createToken sets tenant_id (M2)
An app-scoped token's resolved `tenantId` now equals its app's tenant
immediately (was wrongly `platform` until a restart); a global token resolves to
`platform`. The former `it.failing` bug-doc is now a passing assertion.

### `metrics.controller.spec.ts` (new) — M8 default-deny
No `METRICS_TOKEN` → `/metrics` 404s (not exposed). With a token: 403 on
missing/mismatched credential, 200 with the correct `Bearer` header or `?token=`.

### `shared/http/auth-rate-limit.spec.ts` (new) — M6 brute-force limiting
N attempts on `/auth/login` → `429` (`error.code:'rate_limited'`); a normal
route is never limited; the limiter is scoped to exactly the documented
sensitive paths (login/magic-link/magic-verify).

### `shared/auth/auth.guard.spec.ts` (new) — M6 fail-closed
No validator bound: **allow** in dev/test (skeleton boots), **401** in production
on a protected route; `@Public` stays open; a bound validator delegates and
passes on success / 401 on failure.

### `test/fase0-security.e2e-spec.ts` (new) — golden rule + M2 over HTTP
Full app, real guards, `AUTHZ=on`. GOLDEN RULE: a global `sk_` token and the
break-glass admin JWT reach BOTH apps (config, s3, db/health) — never 403. M2: an
app-A token gets 403 on app B's config, s3, mint-token and db/purge, but 200 on
its own app, and still authenticates (`/auth/me`).

---

## Cuenta y auth (account / 2FA / invites / signup gate / cooldown)

### `modules/auth/account.service.spec.ts` (new)
"Mi cuenta" + TOTP 2FA. Profile: GET returns own user + tenant/role; PATCH
updates name/email (normalised, uniqueness enforced); the break-glass admin's
email is env-managed (400) and `sk_` tokens get 403 (machines have no account).
Password change requires the CURRENT password (login works with the new one,
old rejected). 2FA: setup stores the secret **encrypted at rest**
(`aesgcm$…`, never plaintext) as pending + returns otpauth URI and a PNG-data-URI
QR; enable only activates with a live code; disable requires a code and wipes
secrets; **password login answers 401 `totp_required`/`totp_invalid`** while
enabled; the env break-glass path is exempt (never lockable); setup refused
while already enabled.

### `modules/auth/tenant-invites.controller.spec.ts` (new)
Email invitations. POST creates a **pending** user + membership in the CALLER's
tenant and emails a 72h single-use invite link (owner/superadmin only — editor/
viewer 403, unscoped 400; existing member and the break-glass admin email
rejected; role defaults viewer). The emailed link verifies into a session and
promotes the invitee (pending → active, invited role kept). GET lists only the
still-pending invitations. DELETE revokes: membership removed, orphan
invite-born user deleted, outstanding links invalidated; accepted invites and
foreign users are refused.

### `modules/auth/signup-flag.spec.ts` (new)
`STREAMHUB_ALLOW_SIGNUP` gate. ON → signup creates user + tenant + owner
membership. OFF → a brand-new email gets `403 signup_disabled` and NOTHING is
created; an invited pending user may still complete signup keeping their
invited membership. `GET /auth/config` surfaces the flag.

### `modules/auth/magic-link.service.spec.ts` (updated) — cooldown + invites + 2FA
New: a 2nd request for the same email within 60s → `{ reason:'cooldown',
retryAfterSeconds }` with NO second email; after >60s it sends again; the
cooldown is per-address (no cross-talk) and owner-issued invite links neither
consume nor trip it (nor the window limits). Invite links verify exactly like
login links. Magic verify with 2FA enabled demands the code BEFORE burning the
one-time token (missing → `totp_required`, wrong → `totp_invalid`, the SAME
link then succeeds with a valid code).

### `modules/auth/session.service.spec.ts` (new) — active sessions
Every human sign-in mints a `sessions` row whose id rides in the JWT as `sid`:
password login / signup / magic all create one (ip + user-agent captured).
`listForUser` surfaces ip + created date and flags the CURRENT session. The auth
validator ACCEPTS a live session then REJECTS the SAME token once its session is
revoked; a JWT whose `sid` never existed is rejected, but a legacy token with no
`sid` is still accepted (grace, never mass-logout). A user can NEVER revoke
another user's session (own-only predicate); `revokeOthers` closes every session
but the current one. Password recovery (`reset.service`/`reset.e2e`) was removed
— magic-link is the only account-recovery path.

### `streamhub-web/src/lib/authFlows.spec.ts` (new, node:test)
Pure SPA helpers: `isTotpRequired`/`isTotpInvalid` only match a 401 with the
exact marker (body or message); `cooldownSecondsFrom` reads
`retryAfterSeconds` out of a 429 (rounds up, falls back to 60 on a bare 429,
null on non-429); `validateSignup` reports the first problem
(email/min-length/mismatch); `formatCooldown` clamps + rounds.

---

## UI Streams / Ingress / Grabaciones (feat/streams-ingress-ui)

### `modules/livekit/ingress-list.spec.ts` (new) — 8
`GET /apps/:app/ingress` is now PAGINATED (`{ data, total, limit, offset }`)
for CCTV-scale fleets. Pins: permission metadata stays `ingress:read`; tenant
isolation by app room prefix (foreign rows never leak); limit/offset slicing
with clamp-not-reject (1..500 / >=0); every row carries the revealable ingest
credentials (`stream_key` + `rtmp_url` built from `RTMP_PUBLIC_HOST`) plus live
state (status/bitrate/dimensions) and `requires_password` from `ingress_auth`;
viewers resolved with ONE `listRooms` call over the page rooms only and degrade
to `null` (never fail the listing); `room`/`q` filters.

### `modules/recording/vod-probe.spec.ts` (new) — 6
`POST /apps/:app/vods/:id/probe` backfills media metadata for legacy VODs
(pre-metadata pipeline). Pins: `vod:write` permission metadata; local file →
ffprobe on the path; no local file + S3 object → ffprobe over a presigned URL;
best-effort (all-null probe leaves the row untouched, `probed:false`); an
existing `format` is never clobbered; 404 for no-media and unknown ids.
media.util is mocked — no child process spawns.

### streamhub-web (node:test) — `lib/mediaFormat.spec.ts`, `lib/ingest.spec.ts`, `lib/queryParams.spec.ts` (updated)
Pure UI logic for the same feature: duration formatting (mm:ss / h:mm:ss, dash
on unknown), bitrate formatting, VOD field pickers (`durationS`/`startedAt`
with legacy-spelling tolerance — the Grabaciones "—" fix), ingest URL
join/split (OBS Server/Stream Key halves) + secret masking, and the paginated
ingress query builder (limit/offset math, 0-offset kept, filters trimmed).

---

## Restream multi-destino (feat/restream-multidestino)

### `modules/restream/restream.service.spec.ts` (new) — 22
RestreamService + RestreamController over a REAL migrated per-app DB
(`restream_targets`, APP_MIGRATIONS #7) with LiveKit/Streams/Callbacks mocked:
- add() builds the destination URL from the preset (YouTube/Twitch/Facebook
  base + key, or custom rtmp(s)://) and launches ONE stream egress per target;
- N simultaneous destinations, each with its own egressId; duplicate live
  destination → 409; unknown stream → 404;
- **the destination stream key never leaves the server**: views/callbacks only
  carry `urlMasked`; the full url stays server-side for retries;
- webhook state machine: EGRESS_ACTIVE → active; EGRESS_FAILED marks ONLY that
  endpoint failed + fires `restream_failed` (the others stay active — one
  endpoint can never take the rest down); COMPLETE/ABORTED → stopped +
  `restream_stopped`; manual stop never double-fires when the webhook lands;
- bounded retry with backoff (fake timers): relaunch on failure with a fresh
  egress + retries+1; a target stopped meanwhile is NOT retried;
- RBAC wiring: POST/GET/DELETE declare broadcast:start/read/stop; POST enforces
  the tenant egress quota first;
- per-app isolation: rows live in the app's own app.db — invisible from
  another app (list empty, remove 404).

### `modules/restream/restream.presets.spec.ts` (new) — 13
Pure preset/URL helpers: per-platform URL building, validation (missing
key/url, non-rtmp scheme, key smuggling via slashes/spaces) and
`maskRtmpUrl` — the full key never survives masking (incl. query params).

### streamhub-web (node:test) — `lib/restream.spec.ts` (new) — 6
Mirror of the preset logic driving the AddTarget form: destination URL preview
per platform, custom URL passthrough/key join, and pre-submit validation
(i18n error keys).

---

## Deface face-obfuscation + plugin live-data channel (feat/deface)

### `modules/plugins/plugin-livedata.spec.ts` (new) — 11
The worker→core→player live-data channel (`POST/GET /apps/:app/plugins/:id/live`).

Invariants:
- **Latest-only store** per (app, plugin, room) with `ts`/`ageMs` freshness;
  payloads over 64 KB rejected; key space capped with oldest-first eviction;
  `clear()` scoped to one plugin.
- **Ingest auth**: the worker-hook mints a fresh token per worker START and
  injects `STREAMHUB_INGEST_URL`/`_TOKEN` into the spawned env; pushes without
  the CURRENT running worker's token → 401; a stopped worker's token is dead.
- **Payload contract**: must be a JSON object carrying a non-empty `room`;
  no-worker plugins can never ingest.
- **Public read gating**: only installed + ENABLED `player-overlay` plugins
  answer (404 otherwise); no data yet → `{ts:null,...}` not a 404; uninstall
  clears the feed.

### `src/plugins/deface/plugin.meta.spec.ts` (new) — 7
The deface manifest + pure `worker.spawn(ctx)`: id/category/ui contract, all
11 deface CLI options present **with defaults** (install-valid with no config),
select/number bounds mirror the deface CLI, config → `DEFACE_*` env mapping,
cuda toggle → execution provider, `DEFACE_WORKER_DIR`/`PLUGIN_PYTHON`
operator overrides, discovery by the real registry.

### `deface-worker/` (pytest) — 37, no onnxruntime/opencv needed
Pure logic of the Python worker: env parsing + clamping (`DEFACE_*`,
callback fallback to `STREAMHUB_INGEST_URL`), stream-source resolution,
mask-scale box math (deface `scale_bb` semantics), normalization + degenerate
drop, IoU/greedy-NMS, the CenterFace heatmap decode (stride-4 exp/offset math,
thresh, clamping), atomic model download/caching, callback payload builder +
poster (ingest-token header, error swallowing), FPS throttle, and the
detect→POST loop — **empty frames are posted too** (they clear overlay masks).

### streamhub-web (node:test) — `src/plugins/deface/overlay.util.spec.ts` (new) — 20
Pure overlay logic: settings resolution (defaults mirror the backend schema,
clamping, garbage-safe), live-payload parsing (clamped to the unit square,
malformed faces dropped), **mask-scale applied exactly once** (pre-expanded
payloads pass through; external payloads expand client-side), poll/staleness
policy bounds, face TRACKS (identity kept across moves, unmatched tracks HELD
before dropping — over-mask rather than flicker), frame-rate-independent
exponential smoothing incl. exact settling, letterbox (`object-fit: contain`)
geometry, mosaic grid / blur radius / mask shape helpers.

---

## Cross-cutting invariants this suite locks

- **One publisher = one stream.** Canonical key `${room}/${identity}`; webhook
  and reconcile converge on a single row; viewers/subscribers never create
  streams. (The over-count regression is pinned.)
- **Tenant isolation.** Apps home to a tenant; cross-tenant reads/actions are
  403 under AUTHZ=on; a fresh app is homed to platform.
- **Superadmin / sk_ / unscoped never locked out.** Enforced across off/log/on
  modes and quotas.
- **Secrets never leak.** Credentials masked in responses, never written to
  YAML; token plaintext returned once, only hashes stored; S3 errors don't leak
  secrets.
- **Webhooks always ack 200; callbacks never throw.** Delivery retries are
  bounded and swallow failures.
- **VOD safety.** Upload failure keeps the local file; delete cascades S3 + local
  + row; recordings drain fully on purge.
- **Config editor is fail-safe.** A bad YAML never overwrites a good one; every
  PUT is backed up (≤20) and revertible.
