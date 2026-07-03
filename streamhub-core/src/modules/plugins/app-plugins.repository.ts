/**
 * Persistence for INSTALLED plugins (per-app app.db `app_plugins` table).
 *
 * Thin, synchronous better-sqlite3 access reached via DbService.appDb(app).
 * The catalog itself is code (PluginRegistryService); this only tracks install
 * state + validated config_json per app.
 */
import { Injectable } from '@nestjs/common';
import { DbService } from '../../shared/db/db.service';

/** A row of app_plugins, decoded (config parsed, enabled → boolean). */
export interface InstalledPlugin {
  pluginId: string;
  enabled: boolean;
  config: Record<string, unknown>;
  installedAt: string;
  updatedAt: string;
}

interface Row {
  plugin_id: string;
  enabled: number;
  config_json: string | null;
  installed_at: string;
  updated_at: string;
}

@Injectable()
export class AppPluginsRepository {
  constructor(private readonly db: DbService) {}

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
    };
  }

  list(app: string): InstalledPlugin[] {
    const rows = this.db
      .appDb(app)
      .prepare(
        `SELECT plugin_id, enabled, config_json, installed_at, updated_at
           FROM app_plugins ORDER BY installed_at ASC`,
      )
      .all() as Row[];
    return rows.map((r) => this.map(r));
  }

  get(app: string, pluginId: string): InstalledPlugin | null {
    const row = this.db
      .appDb(app)
      .prepare(
        `SELECT plugin_id, enabled, config_json, installed_at, updated_at
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
    this.db
      .appDb(app)
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
    this.db
      .appDb(app)
      .prepare(`UPDATE app_plugins SET ${sets.join(', ')} WHERE plugin_id = ?`)
      .run(...(params as never[]));
  }

  remove(app: string, pluginId: string): void {
    this.db
      .appDb(app)
      .prepare('DELETE FROM app_plugins WHERE plugin_id = ?')
      .run(pluginId);
  }
}
