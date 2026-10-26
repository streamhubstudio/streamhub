/**
 * Per-app PIN HISTORY (app.db `plugin_version_history`).
 *
 * Every version change of an install (`app_plugins.worker_version`) appends one
 * row here: {from, to, at}. `null` = the built-in/latest semantics (unpinned).
 * The history is what makes ROLLBACK possible — rollback repins to the `from` of
 * the most recent change — and gives the dashboard/CLI an audit trail.
 *
 * The table is created idempotently on first access (SQLite has no CREATE-IF and
 * the numbered app migrations are scaffolder-owned), exactly like
 * AppPluginsRepository ensures its `worker_desired` column.
 */
import { Injectable } from '@nestjs/common';
import { DbService, type Db } from '../../../shared/db/db.service';

/** One decoded history row (newest first when listed). */
export interface VersionChange {
  id: number;
  pluginId: string;
  /** Version before the change, or null when it was builtin/latest. */
  from: string | null;
  /** Version after the change, or null when now builtin/latest. */
  to: string | null;
  at: string;
}

interface Row {
  id: number;
  plugin_id: string;
  from_version: string | null;
  to_version: string | null;
  changed_at: string;
}

@Injectable()
export class PluginVersionHistoryRepository {
  /** Apps whose app.db has already had the history table ensured. */
  private readonly ensured = new Set<string>();

  constructor(private readonly db: DbService) {}

  private adb(app: string): Db {
    const db = this.db.appDb(app);
    if (this.ensured.has(app)) return db;
    try {
      db.exec(
        `CREATE TABLE IF NOT EXISTS plugin_version_history (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           plugin_id TEXT NOT NULL,
           from_version TEXT,
           to_version TEXT,
           changed_at TEXT NOT NULL DEFAULT (datetime('now'))
         )`,
      );
    } catch {
      /* concurrent create / db not ready — the SELECTs tolerate absence */
    }
    this.ensured.add(app);
    return db;
  }

  /** Append a change. from/to are version ids or null (builtin/latest). */
  record(
    app: string,
    pluginId: string,
    from: string | null,
    to: string | null,
  ): void {
    this.adb(app)
      .prepare(
        `INSERT INTO plugin_version_history (plugin_id, from_version, to_version)
           VALUES (?, ?, ?)`,
      )
      .run(pluginId, from, to);
  }

  /** History for one install, newest first. */
  list(app: string, pluginId: string, limit = 50): VersionChange[] {
    let rows: Row[] = [];
    try {
      rows = this.adb(app)
        .prepare(
          `SELECT id, plugin_id, from_version, to_version, changed_at
             FROM plugin_version_history
            WHERE plugin_id = ?
            ORDER BY id DESC
            LIMIT ?`,
        )
        .all(pluginId, Math.max(1, limit)) as Row[];
    } catch {
      rows = [];
    }
    return rows.map((r) => ({
      id: r.id,
      pluginId: r.plugin_id,
      from: r.from_version,
      to: r.to_version,
      at: r.changed_at,
    }));
  }

  /** The most recent change for an install, or null when none recorded. */
  latest(app: string, pluginId: string): VersionChange | null {
    return this.list(app, pluginId, 1)[0] ?? null;
  }
}
