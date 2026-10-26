/**
 * Persistence for INSTALLED plugins (per-app app.db `app_plugins` table).
 *
 * Thin, synchronous better-sqlite3 access reached via DbService.appDb(app).
 * The catalog itself is code (PluginRegistryService); this only tracks install
 * state + validated config_json per app.
 *
 * DESIRED WORKER STATE — `worker_desired` ('running'|'stopped'|NULL) records the
 * OPERATOR INTENT for a needsWorker plugin, so a worker SURVIVES a core restart:
 * start/enable → 'running', stop/disable → 'stopped'. The boot-resume reads it to
 * decide what to (re)start. The column is added idempotently on first access
 * (SQLite has no `ADD COLUMN IF NOT EXISTS`, and the app.db numbered migrations
 * are scaffolder-owned), so pre-existing app.dbs upgrade transparently; NULL means
 * "no intent recorded yet" and is backfilled conservatively by the boot-resume.
 */
import { Injectable } from '@nestjs/common';
import { DbService, type Db } from '../../shared/db/db.service';

/** Operator intent for a needsWorker plugin's process across restarts. */
export type WorkerDesired = 'running' | 'stopped';

/** A row of app_plugins, decoded (config parsed, enabled → boolean). */
export interface InstalledPlugin {
  pluginId: string;
  enabled: boolean;
  config: Record<string, unknown>;
  installedAt: string;
  updatedAt: string;
  /** Desired worker state, or null when no intent was ever recorded. */
  workerDesired: WorkerDesired | null;
  /**
   * Pinned appstore version (`app_plugins.worker_version`), or null = the
   * built-in/latest semantics. The worker spawn resolves this install's worker
   * source to the pinned extracted bundle instead of the shipped source dir.
   */
  workerVersion: string | null;
}

interface Row {
  plugin_id: string;
  enabled: number;
  config_json: string | null;
  installed_at: string;
  updated_at: string;
  worker_desired: string | null;
  worker_version: string | null;
}

@Injectable()
export class AppPluginsRepository {
  /** Apps whose app.db has already had the `worker_desired` column ensured. */
  private readonly ensured = new Set<string>();

  constructor(private readonly db: DbService) {}

  /**
   * Return the app.db handle, ensuring the `worker_desired` + `worker_version`
   * columns exist first (idempotent, once per app per process). Keeps these
   * additive upgrades out of the scaffolder-owned numbered app migrations.
   */
  private adb(app: string): Db {
    const db = this.db.appDb(app);
    if (this.ensured.has(app)) return db;
    try {
      const cols = db.prepare('PRAGMA table_info(app_plugins)').all() as {
        name: string;
      }[];
      const names = new Set(cols.map((c) => c.name));
      if (!names.has('worker_desired')) {
        db.exec('ALTER TABLE app_plugins ADD COLUMN worker_desired TEXT');
      }
      if (!names.has('worker_version')) {
        db.exec('ALTER TABLE app_plugins ADD COLUMN worker_version TEXT');
      }
    } catch {
      /* table not created yet / concurrent add — the SELECTs tolerate NULL */
    }
    this.ensured.add(app);
    return db;
  }

  private map(row: Row): InstalledPlugin {
    let config: Record<string, unknown> = {};
    if (row.config_json) {
      try {
        config = JSON.parse(row.config_json) as Record<string, unknown>;
      } catch {
        config = {};
      }
    }
    return {
      pluginId: row.plugin_id,
      enabled: row.enabled === 1,
      config,
      installedAt: row.installed_at,
      updatedAt: row.updated_at,
      workerDesired:
        row.worker_desired === 'running' || row.worker_desired === 'stopped'
          ? row.worker_desired
          : null,
      workerVersion: row.worker_version ?? null,
    };
  }

  list(app: string): InstalledPlugin[] {
    const rows = this.adb(app)
      .prepare(
        `SELECT plugin_id, enabled, config_json, installed_at, updated_at, worker_desired, worker_version
           FROM app_plugins ORDER BY installed_at ASC`,
      )
      .all() as Row[];
    return rows.map((r) => this.map(r));
  }

  get(app: string, pluginId: string): InstalledPlugin | null {
    const row = this.adb(app)
      .prepare(
        `SELECT plugin_id, enabled, config_json, installed_at, updated_at, worker_desired, worker_version
           FROM app_plugins WHERE plugin_id = ?`,
      )
      .get(pluginId) as Row | undefined;
    return row ? this.map(row) : null;
  }

  /** Insert a fresh install (default enabled). No-op if already present. */
  install(
    app: string,
    pluginId: string,
    config: Record<string, unknown>,
    enabled = true,
  ): void {
    this.adb(app)
      .prepare(
        `INSERT OR IGNORE INTO app_plugins (plugin_id, enabled, config_json)
           VALUES (?, ?, ?)`,
      )
      .run(pluginId, enabled ? 1 : 0, JSON.stringify(config));
  }

  /** Patch enabled and/or config. Bumps updated_at. */
  update(
    app: string,
    pluginId: string,
    patch: { enabled?: boolean; config?: Record<string, unknown> },
  ): void {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.enabled !== undefined) {
      sets.push('enabled = ?');
      params.push(patch.enabled ? 1 : 0);
    }
    if (patch.config !== undefined) {
      sets.push('config_json = ?');
      params.push(JSON.stringify(patch.config));
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    params.push(pluginId);
    this.adb(app)
      .prepare(`UPDATE app_plugins SET ${sets.join(', ')} WHERE plugin_id = ?`)
      .run(...(params as never[]));
  }

  /**
   * Record the desired worker state for an install (operator intent that must
   * survive a restart). No-op on an unknown plugin. Does NOT bump updated_at —
   * this is internal lifecycle bookkeeping, not a user edit.
   */
  setWorkerDesired(app: string, pluginId: string, desired: WorkerDesired): void {
    this.adb(app)
      .prepare('UPDATE app_plugins SET worker_desired = ? WHERE plugin_id = ?')
      .run(desired, pluginId);
  }

  /**
   * Pin (or unpin, with null) the appstore version an install runs. null =
   * built-in/latest. Does NOT bump updated_at — this is lifecycle bookkeeping,
   * not a user config edit, and the pin history table is the audit trail.
   */
  setWorkerVersion(
    app: string,
    pluginId: string,
    version: string | null,
  ): void {
    this.adb(app)
      .prepare('UPDATE app_plugins SET worker_version = ? WHERE plugin_id = ?')
      .run(version, pluginId);
  }

  remove(app: string, pluginId: string): void {
    this.adb(app)
      .prepare('DELETE FROM app_plugins WHERE plugin_id = ?')
      .run(pluginId);
  }
}
