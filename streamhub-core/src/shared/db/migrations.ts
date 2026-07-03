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
  // for ESP32-CAM devices — streamhub-docs/integrations/ESP32-WS-INGEST.md).
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
];
