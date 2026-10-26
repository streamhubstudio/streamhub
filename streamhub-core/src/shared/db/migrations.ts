/**
 * SQL migrations for StreamHub SQLite databases (SPEC §4).
 *
 * Layout (AntMedia-style, decentralized — see DbService):
 *
 *   GLOBAL_MIGRATIONS → data/streamhub.db  — cross-cutting identity + routing
 *     ONLY: tenants, users, memberships, api_tokens, quotas, apps (pointer:
 *     name + tenant_id + node_id + created_at, plus legacy config columns kept
 *     for back-compat), server_logs (server-wide operational log), and nodes
 *     (cluster registry, currently empty / future).
 *
 *   APP_MIGRATIONS → apps/<name>/app.db    — EVERYTHING app-scoped
 *     streams, vods (consolidated from the legacy per-app vods.db) and
 *     ingress_auth (RTMP key/password metadata). The physical media files
 *     (recordings/hls/snapshots/samples) stay on disk under apps/<name>/; only
 *     their METADATA lives here. Future app-scoped tables (snapshots,
 *     callbacks-log, samples-refs, …) also belong in this DB.
 *
 * config.yaml stays the per-app, human-editable config file — it is NOT a DB.
 *
 * Migrations are plain idempotent DDL applied in order. Each DB tracks the
 * applied count via `PRAGMA user_version`. NOTE: never reorder/remove an
 * existing entry — installed DBs key off the array length.
 */

export const GLOBAL_MIGRATIONS: string[] = [
  // 1 — apps registry
  `CREATE TABLE IF NOT EXISTS apps (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT NOT NULL UNIQUE,
     display_name TEXT,
     livekit_room_prefix TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at TEXT NOT NULL DEFAULT (datetime('now')),
     settings_json TEXT
   );`,

  // 2 — api tokens
  `CREATE TABLE IF NOT EXISTS api_tokens (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT NOT NULL,
     token_hash TEXT NOT NULL,
     scope TEXT NOT NULL CHECK (scope IN ('global','app')),
     app_id INTEGER,
     allowed_ips_json TEXT,
     last_used_at TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     revoked INTEGER NOT NULL DEFAULT 0,
     FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE
   );
   CREATE INDEX IF NOT EXISTS idx_api_tokens_hash ON api_tokens(token_hash);`,

  // 3 — server logs
  `CREATE TABLE IF NOT EXISTS server_logs (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     ts TEXT NOT NULL DEFAULT (datetime('now')),
     level TEXT NOT NULL,
     source TEXT,
     app_id INTEGER,
     message TEXT NOT NULL,
     meta_json TEXT,
     FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE SET NULL
   );
   CREATE INDEX IF NOT EXISTS idx_server_logs_ts ON server_logs(ts);
   CREATE INDEX IF NOT EXISTS idx_server_logs_app_level ON server_logs(app_id, level);`,

  // 4 — RTMP ingress auth (SPEC §16 rtmp key + password). One row per ingress;
  // password_hash is null when the app does not require a stream password.
  //
  // NOTE (per-app split): this table now ALSO lives per-app in app.db (see
  // APP_MIGRATIONS) and is the eventual home. It is retained here for
  // back-compat because the current ingress-auth service still looks rows up by
  // ingress_id alone (no app in scope on the webhook path). The per-app split
  // migration COPIES existing rows into each app's app.db; the global copy is
  // left intact until the ingress-auth service + webhook callers are reworked
  // to thread the app name and switch to appDb(app). Do NOT drop it here.
  `CREATE TABLE IF NOT EXISTS ingress_auth (
     ingress_id TEXT PRIMARY KEY,
     app TEXT NOT NULL,
     room TEXT,
     stream_key TEXT,
     password_hash TEXT,
     password_salt TEXT,
     requires_password INTEGER NOT NULL DEFAULT 0,
     validated_at TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE INDEX IF NOT EXISTS idx_ingress_auth_app ON ingress_auth(app);`,

  // 5 — multi-tenant control-plane (Wave-5 §auth). Tenants, the mirrored user
  // table (identity-of-record lives in the OIDC IdP), per-tenant memberships
  // (role) and per-tenant quotas. `tenants.id` is a TEXT id (= IdP org id in
  // production; the built-in tenant uses the literal id 'platform').
  `CREATE TABLE IF NOT EXISTS tenants (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     plan TEXT NOT NULL DEFAULT 'free',
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   );

   CREATE TABLE IF NOT EXISTS users (
     id TEXT PRIMARY KEY,
     email TEXT,
     is_superadmin INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

   CREATE TABLE IF NOT EXISTS memberships (
     user_id TEXT NOT NULL,
     tenant_id TEXT NOT NULL,
     role TEXT NOT NULL DEFAULT 'viewer'
       CHECK (role IN ('owner','editor','viewer')),
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     PRIMARY KEY (user_id, tenant_id),
     FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
     FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
   );
   CREATE INDEX IF NOT EXISTS idx_memberships_tenant ON memberships(tenant_id);

   CREATE TABLE IF NOT EXISTS quotas (
     tenant_id TEXT PRIMARY KEY,
     max_apps INTEGER NOT NULL DEFAULT 2,
     max_concurrent_streams INTEGER NOT NULL DEFAULT 2,
     max_recording_minutes_month INTEGER NOT NULL DEFAULT 300,
     max_egress_gb_month INTEGER NOT NULL DEFAULT 5,
     max_storage_gb INTEGER NOT NULL DEFAULT 5,
     FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
   );`,

  // 6 — bolt tenant_id onto apps + api_tokens, then seed the built-in
  // 'platform' tenant and re-home everything that predates tenancy. Idempotent:
  // the ALTERs are guarded at runtime (see ensureTenantColumns) because SQLite
  // can't `ADD COLUMN IF NOT EXISTS`; the INSERT/UPDATE statements below are
  // safe to re-run (INSERT OR IGNORE / WHERE tenant_id IS NULL).
  `INSERT OR IGNORE INTO tenants (id, name, plan)
     VALUES ('platform', 'Platform', 'platform');
   INSERT OR IGNORE INTO quotas
     (tenant_id, max_apps, max_concurrent_streams,
      max_recording_minutes_month, max_egress_gb_month, max_storage_gb)
     VALUES ('platform', 100000, 100000, 100000000, 100000, 100000);`,

  // 7 — cluster/routing scaffolding for the decentralized split:
  //   * nodes  — cluster node registry (empty for now; future multi-node
  //     routing. apps.node_id points here — see GLOBAL_COLUMN_ADDS).
  //   * _streamhub_meta — key/value bookkeeping for one-shot data migrations
  //     (e.g. the per-app split flag). Kept out of user_version so the split can
  //     be re-derived independently of schema versioning.
  `CREATE TABLE IF NOT EXISTS nodes (
     id TEXT PRIMARY KEY,
     name TEXT,
     url TEXT,
     region TEXT,
     status TEXT NOT NULL DEFAULT 'unknown',
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     last_seen_at TEXT
   );

   CREATE TABLE IF NOT EXISTS _streamhub_meta (
     key TEXT PRIMARY KEY,
     value TEXT,
     updated_at TEXT NOT NULL DEFAULT (datetime('now'))
   );`,

  // 8 — hot-path indices for the global registry so it stays fast under
  // volume (token auth on every request, per-app log queries/purges). Only
  // columns guaranteed present by earlier numbered migrations are indexed
  // here; the tenancy columns (added at runtime via GLOBAL_COLUMN_ADDS AFTER
  // the numbered migrations) get their indices in GLOBAL_TENANCY_BACKFILL.
  // CREATE INDEX IF NOT EXISTS = idempotent.
  `CREATE INDEX IF NOT EXISTS idx_api_tokens_app ON api_tokens(app_id);
   CREATE INDEX IF NOT EXISTS idx_server_logs_app_ts ON server_logs(app_id, ts);`,

  // 9 — Vision Edge assignments (modules/edge). One row = one worker workload
  // placed on one node: (app, plugin_id, stream_id?) with its resolved config.
  // Survives master restarts so the scheduler can re-offer work to an edge
  // that reconnects. `stream_id` NULL = an app-wide (not per-stream) worker.
  // status: pending → offered → running → (stopped | failed | revoked).
  // Node rows are global (nodes table), apps are per-tenant — this table is
  // the JOIN between the two planes, so it lives in the GLOBAL db.
  `CREATE TABLE IF NOT EXISTS edge_assignments (
     id TEXT PRIMARY KEY,
     node_id TEXT NOT NULL,
     app TEXT NOT NULL,
     plugin_id TEXT NOT NULL,
     stream_id TEXT,
     config_json TEXT,
     status TEXT NOT NULL DEFAULT 'pending',
     detail TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE INDEX IF NOT EXISTS idx_edge_assignments_node ON edge_assignments(node_id, status);
   CREATE INDEX IF NOT EXISTS idx_edge_assignments_app ON edge_assignments(app, plugin_id);`,
];

/**
 * Columns added to pre-existing tables that SQLite cannot express with
 * `ADD COLUMN IF NOT EXISTS`. Applied idempotently by DbService AFTER the
 * numbered migrations (checks the table's column list first). Backfill of these
 * columns to the 'platform' tenant is done in the same pass.
 */
export const GLOBAL_COLUMN_ADDS: { table: string; column: string; ddl: string }[] = [
  // DEFAULT 'platform' so (a) every pre-existing row is re-homed to the
  // platform tenant the instant the column appears, and (b) any app/token
  // created later in this same boot (e.g. the seeded `live` app) also lands in
  // 'platform' until tenancy explicitly reassigns it.
  {
    table: 'apps',
    column: 'tenant_id',
    ddl: `ALTER TABLE apps ADD COLUMN tenant_id TEXT DEFAULT 'platform'`,
  },
  {
    table: 'api_tokens',
    column: 'tenant_id',
    ddl: `ALTER TABLE api_tokens ADD COLUMN tenant_id TEXT DEFAULT 'platform'`,
  },
  // Cluster-routing pointer: which node owns this app's per-app data/media.
  // NULL = the local/single node (current deployment). Part of reducing `apps`
  // to a pure identity+routing pointer.
  {
    table: 'apps',
    column: 'node_id',
    ddl: `ALTER TABLE apps ADD COLUMN node_id TEXT`,
  },
  // Cluster manager: the last stats blob a node reported on its heartbeat
  // (free-form JSON — CPU/streams/etc., capped ~4KB by the heartbeat handler).
  // NULL until the node first reports stats. Added at runtime because the
  // `nodes` table predates this column and SQLite has no ADD COLUMN IF NOT EXISTS.
  {
    table: 'nodes',
    column: 'stats_json',
    ddl: `ALTER TABLE nodes ADD COLUMN stats_json TEXT`,
  },
  // Vision Edge cluster (modules/edge): what KIND of node this is.
  //   'common' — a full media node (today's only kind; the default keeps every
  //              pre-existing row meaning exactly what it meant).
  //   'edge'   — a worker/compute node (vision-first): joins via the outbound
  //              edge WebSocket, receives worker assignments, runs NO public
  //              media plane. Set by the installer (--node-type edge) at join.
  {
    table: 'nodes',
    column: 'type',
    ddl: `ALTER TABLE nodes ADD COLUMN type TEXT NOT NULL DEFAULT 'common'`,
  },
  // Vision Edge scheduler: relative priority weight for the 'weighted' policy
  // (share of new assignments ∝ weight/Σweights among eligible edges). 100 =
  // the neutral default so round_robin deployments never notice the column.
  {
    table: 'nodes',
    column: 'weight',
    ddl: `ALTER TABLE nodes ADD COLUMN weight INTEGER NOT NULL DEFAULT 100`,
  },
];

/**
 * Backfill statements run after the column adds: re-home every app/token that
 * predates tenancy to the built-in 'platform' tenant. Idempotent (WHERE … IS
 * NULL). App-scoped tokens then inherit their app's tenant.
 */
export const GLOBAL_TENANCY_BACKFILL: string[] = [
  `UPDATE apps SET tenant_id = 'platform' WHERE tenant_id IS NULL;`,
  `UPDATE api_tokens SET tenant_id = 'platform' WHERE tenant_id IS NULL;`,
  `UPDATE api_tokens
      SET tenant_id = (SELECT a.tenant_id FROM apps a WHERE a.id = api_tokens.app_id)
    WHERE scope = 'app' AND app_id IS NOT NULL
      AND (SELECT a.tenant_id FROM apps a WHERE a.id = api_tokens.app_id) IS NOT NULL;`,
  // Tenancy hot-path indices. Live HERE (not in a numbered migration) because
  // the tenant_id columns are only added by GLOBAL_COLUMN_ADDS, which runs
  // AFTER the numbered migrations — indexing them in a numbered migration on a
  // fresh DB would fail (column not yet present). Idempotent.
  `CREATE INDEX IF NOT EXISTS idx_apps_tenant ON apps(tenant_id);`,
  `CREATE INDEX IF NOT EXISTS idx_api_tokens_tenant ON api_tokens(tenant_id);`,
];

/**
 * Per-app schema (apps/<name>/app.db). Holds ALL app-scoped state. The first
 * two tables (streams, vods) were historically the legacy `vods.db`; DbService
 * imports any legacy vods.db rows into app.db on first open (idempotent).
 */
export const APP_MIGRATIONS: string[] = [
  // 1 — streams
  `CREATE TABLE IF NOT EXISTS streams (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     app_id INTEGER NOT NULL,
     stream_id TEXT NOT NULL UNIQUE,
     type TEXT NOT NULL CHECK (type IN ('webrtc','rtmp','rtsp','whip')),
     room TEXT,
     participant TEXT,
     status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended')),
     started_at TEXT NOT NULL DEFAULT (datetime('now')),
     ended_at TEXT,
     last_stats_json TEXT
   );
   CREATE INDEX IF NOT EXISTS idx_streams_status ON streams(status);`,

  // 2 — vods
  `CREATE TABLE IF NOT EXISTS vods (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     app_id INTEGER NOT NULL,
     stream_id TEXT,
     room TEXT,
     name TEXT NOT NULL,
     file_key TEXT,
     s3_url TEXT,
     public_url TEXT,
     size_bytes INTEGER,
     duration_s REAL,
     width INTEGER,
     height INTEGER,
     format TEXT,
     status TEXT NOT NULL DEFAULT 'recording'
       CHECK (status IN ('recording','uploading','ready','failed')),
     local_path TEXT,
     started_at TEXT,
     ended_at TEXT,
     metatags_json TEXT,
     snapshot_key TEXT
   );
   CREATE INDEX IF NOT EXISTS idx_vods_status ON vods(status);
   CREATE INDEX IF NOT EXISTS idx_vods_stream ON vods(stream_id);`,

  // 3 — per-app RTMP ingress auth (moved down from the global streamhub.db as
  // part of the decentralized split) + per-app migration bookkeeping. Column
  // set mirrors the global `ingress_auth` exactly so the split migration can
  // copy rows verbatim. `app` is redundant here (it's this app) but kept so the
  // copy is 1:1 and the eventual service rewrite is trivial.
  `CREATE TABLE IF NOT EXISTS ingress_auth (
     ingress_id TEXT PRIMARY KEY,
     app TEXT NOT NULL,
     room TEXT,
     stream_key TEXT,
     password_hash TEXT,
     password_salt TEXT,
     requires_password INTEGER NOT NULL DEFAULT 0,
     validated_at TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE INDEX IF NOT EXISTS idx_ingress_auth_app ON ingress_auth(app);

   CREATE TABLE IF NOT EXISTS _streamhub_meta (
     key TEXT PRIMARY KEY,
     value TEXT,
     updated_at TEXT NOT NULL DEFAULT (datetime('now'))
   );`,

  // 4 — hot-path indices on the busy per-app tables so listing/filtering VODs
  // and streams stays fast as their row counts grow (the UI lists newest-first,
  // filters by room/status, and the maintenance/purge paths scan by status).
  // NOTE: the `vods` table has no `created_at`; `started_at` IS its creation
  // timestamp, so the "created_at" index requested by the spec maps to it.
  // CREATE INDEX IF NOT EXISTS = idempotent.
  `CREATE INDEX IF NOT EXISTS idx_vods_room ON vods(room);
   CREATE INDEX IF NOT EXISTS idx_vods_started_at ON vods(started_at);
   CREATE INDEX IF NOT EXISTS idx_vods_status_started ON vods(status, started_at);
   CREATE INDEX IF NOT EXISTS idx_streams_room ON streams(room);
   CREATE INDEX IF NOT EXISTS idx_streams_started_at ON streams(started_at);
   CREATE INDEX IF NOT EXISTS idx_streams_status_started ON streams(status, started_at);`,

  // 5 — plugin/marketplace framework (module `plugins`). One row per plugin
  // INSTALLED into this app. The plugin CATALOG itself is code (auto-discovered
  // built-in plugin.meta.ts files, see src/modules/plugins) and is NOT stored in
  // the DB — this table only records install state + per-app config overrides.
  //   * plugin_id    — the built-in plugin's stable id (FK to the code registry).
  //   * enabled      — 0/1 soft switch (install ≠ enabled-forever; can be paused).
  //   * config_json  — the app's config for this plugin, already validated +
  //                    normalized against the plugin's configSchema (defaults
  //                    filled in). NULL until first configured.
  //   * installed_at / updated_at — audit timestamps.
  // No FK to a catalog table exists (the catalog is code); the service rejects
  // installs of unknown plugin ids. Deleting the app drops app.db wholesale.
  `CREATE TABLE IF NOT EXISTS app_plugins (
     plugin_id TEXT PRIMARY KEY,
     enabled INTEGER NOT NULL DEFAULT 1,
     config_json TEXT,
     installed_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE INDEX IF NOT EXISTS idx_app_plugins_enabled ON app_plugins(enabled);`,

  // 6 — VOD variants (adaptive VOD / multi-encoding). One row per generated
  // variant of a VOD (module `recording`, ffmpeg post-transcode pipeline):
  //   * kind 'master'    — the HLS master playlist (adaptive entry point).
  //   * kind 'rendition' — one HLS rendition (height + bitrate ladder step);
  //     file_key points at the rendition playlist, extra_json carries the
  //     segment object keys (for full S3 cascade on delete).
  //   * kind 'alternate' — an alternate whole-file encoding (e.g. WebM/VP8).
  // The base MP4 stays on the `vods` row itself (file_key); variants are
  // strictly additive. Deleting a VOD deletes its variants (service cascade —
  // no PRAGMA foreign_keys dependency).
  `CREATE TABLE IF NOT EXISTS vod_variants (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     vod_id INTEGER NOT NULL,
     kind TEXT NOT NULL DEFAULT 'rendition'
       CHECK (kind IN ('master','rendition','alternate')),
     format TEXT NOT NULL,
     height INTEGER,
     bitrate_kbps INTEGER,
     file_key TEXT,
     size_bytes INTEGER,
     extra_json TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE INDEX IF NOT EXISTS idx_vod_variants_vod ON vod_variants(vod_id);`,

  // 7 — restream targets (module `restream`: multi-destination RTMP forwarding,
  // AntMedia "endpoints"). One row per destination a room is being forwarded to:
  //   * url        — FULL destination push URL including the stream key. Needed
  //                  to (re)launch the egress on retry; NEVER returned by the
  //                  API (same trust level as ingress_auth.stream_key — the
  //                  app.db is server-side only).
  //   * url_masked — redacted form (key replaced) — the ONLY url the API/UI and
  //                  outbound callbacks ever expose.
  //   * egress_id  — the LiveKit stream egress currently pushing to this
  //                  destination (one egress per destination: a failing
  //                  destination can never take down the others).
  //   * status     — starting|active|failed|stopped (+ error/retries for the
  //                  per-endpoint health/retry loop).
  `CREATE TABLE IF NOT EXISTS restream_targets (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     app TEXT NOT NULL,
     room TEXT NOT NULL,
     stream_id TEXT,
     name TEXT,
     platform TEXT NOT NULL DEFAULT 'custom',
     url TEXT NOT NULL,
     url_masked TEXT NOT NULL,
     egress_id TEXT,
     status TEXT NOT NULL DEFAULT 'starting'
       CHECK (status IN ('starting','active','failed','stopped')),
     error TEXT,
     retries INTEGER NOT NULL DEFAULT 0,
     started_at TEXT NOT NULL DEFAULT (datetime('now')),
     ended_at TEXT
   );
   CREATE INDEX IF NOT EXISTS idx_restream_targets_room ON restream_targets(room);
   CREATE INDEX IF NOT EXISTS idx_restream_targets_egress ON restream_targets(egress_id);
   CREATE INDEX IF NOT EXISTS idx_restream_targets_status ON restream_targets(status);`,

  // 8 — widen streams.type to accept 'ws-mjpeg' (direct WebSocket MJPEG ingest
  // for ESP32-CAM devices — https://streamhub.studio/docs/integrations/ESP32-WS-INGEST).
  // SQLite cannot ALTER a CHECK constraint, so the table is rebuilt in place
  // (same columns/ids) and its indices recreated. Runs inside the migration
  // transaction; on a FRESH app.db migration 1 creates the narrow table and
  // this one immediately widens it — same end state either way.
  `CREATE TABLE streams_v7 (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     app_id INTEGER NOT NULL,
     stream_id TEXT NOT NULL UNIQUE,
     type TEXT NOT NULL CHECK (type IN ('webrtc','rtmp','rtsp','whip','ws-mjpeg')),
     room TEXT,
     participant TEXT,
     status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended')),
     started_at TEXT NOT NULL DEFAULT (datetime('now')),
     ended_at TEXT,
     last_stats_json TEXT
   );
   INSERT INTO streams_v7
     (id, app_id, stream_id, type, room, participant, status, started_at, ended_at, last_stats_json)
     SELECT id, app_id, stream_id, type, room, participant, status, started_at, ended_at, last_stats_json
     FROM streams;
   DROP TABLE streams;
   ALTER TABLE streams_v7 RENAME TO streams;
   CREATE INDEX IF NOT EXISTS idx_streams_status ON streams(status);
   CREATE INDEX IF NOT EXISTS idx_streams_room ON streams(room);
   CREATE INDEX IF NOT EXISTS idx_streams_started_at ON streams(started_at);
   CREATE INDEX IF NOT EXISTS idx_streams_status_started ON streams(status, started_at);`,

  // 9 — scheduled live premieres (module `scheduled-live`: the agenda of
  // scheduled live-stream "premieres"). One row per scheduled event:
  //   * room       — NULL applies the countdown to EVERY room in the app; a
  //                  non-NULL value scopes it to that one room.
  //   * start_at   — the absolute reveal instant as unix epoch MILLISECONDS in
  //                  UTC. The BROWSER converts the operator's picked wall-time +
  //                  IANA timezone into this absolute ms; the backend does NO
  //                  timezone math — it only validates a positive integer.
  //   * timezone   — the IANA zone the wall-time was picked in, kept purely so
  //                  the editor can round-trip the picker and for display.
  //   * enabled    — 0/1 soft switch (an event can be drafted then paused).
  // The public player reads the enabled/upcoming rows to drive the countdown
  // cover; the reveal happens client-side once now >= start_at.
  `CREATE TABLE IF NOT EXISTS scheduled_events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     app TEXT NOT NULL,
     room TEXT,
     title TEXT,
     start_at INTEGER NOT NULL,
     timezone TEXT NOT NULL DEFAULT 'UTC',
     message TEXT,
     enabled INTEGER NOT NULL DEFAULT 1,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE INDEX IF NOT EXISTS idx_scheduled_events_lookup ON scheduled_events(enabled, start_at);`,

  // 10 — per-stream plugin opt-out (module `streams` × `plugins`). By default a
  // plugin enabled on the app applies to EVERY live stream; this column lets an
  // operator opt an INDIVIDUAL stream out of specific plugins. It stores a JSON
  // array of the plugin ids DISABLED for this stream only (e.g. `["watermark"]`
  // hides just the watermark overlay on that one stream). Default '[]' = the
  // stream is affected by all of the app's enabled plugins (back-compat: every
  // existing row keeps behaving exactly as before). `ADD COLUMN … DEFAULT '[]'`
  // is a legal SQLite ALTER (constant default), so no table rebuild is needed;
  // the numbered-migration bookkeeping (user_version) makes it run exactly once.
  `ALTER TABLE streams ADD COLUMN disabled_plugins TEXT NOT NULL DEFAULT '[]';`,

  // 11 — dynamic TAGS (module `tags`). A tag is a small ENTITY with config —
  // e.g. kind 'store' carrying that store's per-model vision settings — that
  // operators create once and then APPLY to streams/ingresses. `slug` is the
  // stable reference stored on streams; `config_json` is the tag's settings
  // blob (schema owned by whoever consumes the tag — vision models read their
  // per-model blocks from it). All CRUD via /apps/:app/tags.
  `CREATE TABLE IF NOT EXISTS tags (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     slug TEXT NOT NULL UNIQUE,
     label TEXT NOT NULL,
     kind TEXT NOT NULL DEFAULT 'custom',
     config_json TEXT NOT NULL DEFAULT '{}',
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE INDEX IF NOT EXISTS idx_tags_kind ON tags(kind);`,

  // 12 — stream tagging (module `tags` × `streams`). JSON array of tag slugs
  // applied to this stream (mirrors the `disabled_plugins` column pattern:
  // constant default = legal ALTER, '[]' = untagged, full back-compat).
  // Detection events emitted for a stream carry these slugs so downstream
  // consumers (callback/MQTT/log) can attribute the event to its entities.
  `ALTER TABLE streams ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';`,

  // 13 — per-app network I/O samples (module `net-metrics`). One row per
  // (hour-bucket × direction × source): byte counts of what enters/leaves
  // THROUGH the app (media planes — HLS served, RTMP/SRT/WHIP ingest, egress
  // pushes), NOT host-wide traffic. The dashboard card reads recent buckets;
  // the threshold monitor compares a rolling window against the app's
  // configured limit and emits `network.threshold` through the callbacks
  // funnel. `source` examples: 'hls', 'rtmp-ingest', 'livekit-egress', 'vod'.
  `CREATE TABLE IF NOT EXISTS net_samples (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     bucket TEXT NOT NULL,
     direction TEXT NOT NULL,
     source TEXT NOT NULL,
     bytes INTEGER NOT NULL DEFAULT 0,
     UNIQUE(bucket, direction, source)
   );
   CREATE INDEX IF NOT EXISTS idx_net_samples_bucket ON net_samples(bucket);`,

  // 14 — MPEG-TS-over-UDP (unicast + multicast) passthrough ingest
  // (features/mpegts-multicast.md). Unlike the RTMP/SRT passthrough transports
  // (push LISTENERS keyed by the port + minted key), an MPEG-TS ingress is a
  // PULL source: the remux `ffmpeg -f mpegts -i udp://@GROUP:PORT -c copy`
  // connects OUT to a multicast group / unicast port. The canonical, validated
  // udp:// input URL is persisted here so boot re-arm can rebuild the exact
  // ffmpeg source after a core restart (RTMP/SRT need no source — their port +
  // key define them). NULL for every RTMP/SRT/WS row (constant-free ADD COLUMN
  // = legal SQLite ALTER, runs exactly once via user_version bookkeeping).
  `ALTER TABLE ingress_auth ADD COLUMN source_url TEXT;`,
];
