/**
 * VISION → 4 APPS boot migration (Edge-as-capability, 2.16.0).
 *
 * The monolithic `vision` plugin retired: its four models became first-class
 * Studio Apps (occupancy / counting / crowd / demography) and its single
 * `vision.db` split into four per-model dbs. This one-shot, idempotent,
 * NON-DESTRUCTIVE migration runs at boot (OnApplicationBootstrap) and, for every
 * app that still carries a `vision` install row:
 *
 *   1. backs up `apps/<app>/vision/vision.db` (`VACUUM INTO` a single-file .bak),
 *   2. splits it into `apps/<app>/<model>/<model>.db` — each gets its own events
 *      table + the `stream_settings` rows for its model (INSERT OR IGNORE, so a
 *      re-run never duplicates),
 *   3. installs the model-apps whose `<model>_enabled` flag was true (occupancy
 *      defaults true), carrying device/fps/confidence (+ demography engine/key),
 *   4. migrates `edge_assignments` rows with plugin_id 'vision' → the per-model
 *      plugin_id (from config_json.model), or revokes them so reconcile recreates,
 *   5. removes the old `vision` install row.
 *
 * Idempotent by construction: step 5 drops the trigger row, so a re-run finds no
 * `vision` install and no-ops. A crash mid-migration re-runs safely (backup
 * skipped if present, INSERT OR IGNORE, install OR IGNORE, remove idempotent).
 * Every app is isolated in its own try/catch — one bad app never bricks boot.
 * Mirrors the `DbService.splitPerApp` style/idempotency.
 */
import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  Optional,
} from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';

import {
  APPS_SERVICE,
  AppsServiceContract,
  LOGS_SERVICE,
  LogsServiceContract,
} from '../../shared/contracts';
import { DbService } from '../../shared/db/db.service';
import { AppPluginsRepository } from '../plugins/app-plugins.repository';
import { defaultConfig, validateConfig } from '../plugins/plugin-config.util';
import { PluginRegistryService } from '../plugins/plugin-registry.service';
import { PluginsService } from '../plugins/plugins.service';
import { VisionStore } from './vision.store';
import { VISION_MODELS, VisionModel, isVisionModel } from './vision.types';

/** Model → its `<model>_enabled` flag on the old vision config. */
const ENABLE_FLAG: Record<VisionModel, string> = {
  occupancy: 'occupancy_enabled',
  counting: 'counting_enabled',
  crowd: 'crowd_enabled',
  demography: 'demography_enabled',
};

/** Model → its event table name in vision.db (identical DDL in the new db). */
const EVENT_TABLE: Record<VisionModel, string> = {
  occupancy: 'occupancy_sessions',
  counting: 'count_events',
  crowd: 'crowd_events',
  demography: 'demography_events',
};

@Injectable()
export class VisionMigrationService implements OnApplicationBootstrap {
  private readonly logger = new Logger(VisionMigrationService.name);

  constructor(
    private readonly db: DbService,
    private readonly installs: AppPluginsRepository,
    private readonly registry: PluginRegistryService,
    private readonly store: VisionStore,
    @Inject(APPS_SERVICE) private readonly apps: AppsServiceContract,
    @Optional() @Inject(LOGS_SERVICE) private readonly logs?: LogsServiceContract,
    // Optional so the unit spec can construct the migration without the whole
    // plugin graph; under Nest DI the singleton is injected and used to start
    // the migrated model-apps' workers in this same boot.
    @Optional() private readonly plugins?: PluginsService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.migrate();
    } catch (err) {
      // Never let the migration brick boot; it retries next start.
      this.logger.error(`vision→apps migration skipped: ${(err as Error).message}`);
    }
  }

  /** Migrate every app that still carries a `vision` install row. */
  async migrate(): Promise<void> {
    let apps: { name: string }[] = [];
    try {
      apps = await this.apps.list();
    } catch {
      return; // db not ready / no apps
    }
    const migratedApps: string[] = [];
    for (const { name } of apps) {
      try {
        if (this.migrateApp(name)) migratedApps.push(name);
      } catch (err) {
        this.logger.error(
          `vision→apps migration for '${name}' failed: ${(err as Error).message}`,
        );
      }
    }
    if (migratedApps.length > 0) {
      this.logger.log(
        `vision→apps migration complete for ${migratedApps.length} app(s)`,
      );
    }
    // Start the migrated model-apps' workers in THIS boot (best-effort) so the
    // deploy doesn't leave detection off until a second restart. The global
    // plugin boot-resume skips the retired 'vision' install (no meta), so this
    // targeted resume is what brings the new per-model workers up now.
    for (const name of migratedApps) {
      try {
        await this.plugins?.resumeDesiredWorkers(name);
      } catch (err) {
        this.logger.debug(
          `post-migration worker resume for '${name}' failed: ${(err as Error).message}`,
        );
      }
    }
  }

  /** Migrate one app. Returns true when a `vision` install was found + migrated. */
  private migrateApp(app: string): boolean {
    const vision = this.installs.get(app, 'vision');
    if (!vision) return false; // already migrated / never had vision

    const appDir = this.apps.appDir(app);
    const visionDb = path.join(appDir, 'vision', 'vision.db');

    this.backup(visionDb);
    this.splitData(app, appDir, visionDb);
    this.installModelApps(app, vision.config, vision.enabled);
    this.migrateAssignments(app);
    this.installs.remove(app, 'vision');

    this.logs?.write('info', 'vision-migration', `migrated app '${app}' vision → 4 apps`, {
      app,
    });
    return true;
  }

  /** One-shot single-file backup of vision.db (WAL-safe VACUUM INTO). */
  private backup(visionDb: string): void {
    try {
      if (!fs.existsSync(visionDb)) return;
      const bak = `${visionDb}.pre-split.bak`;
      if (fs.existsSync(bak)) return;
      const old = new Database(visionDb, { readonly: false });
      try {
        old.exec(`VACUUM INTO '${sqlPath(bak)}'`);
      } finally {
        old.close();
      }
      this.logger.log(`vision.db backed up to ${bak}`);
    } catch (err) {
      this.logger.warn(`vision.db backup failed (continuing): ${(err as Error).message}`);
    }
  }

  /**
   * Split vision.db into the four per-model dbs. For each model: create/open its
   * db (via the store, so the schema matches), ATTACH the old vision.db and copy
   * its events + the stream_settings rows for that model. INSERT OR IGNORE so a
   * re-run is a no-op. Skips silently when vision.db never existed.
   */
  private splitData(app: string, appDir: string, visionDb: string): void {
    if (!fs.existsSync(visionDb)) return;
    for (const model of VISION_MODELS) {
      try {
        const nb = this.store.db(app, appDir, model);
        nb.exec(`ATTACH '${sqlPath(visionDb)}' AS old`);
        try {
          const table = EVENT_TABLE[model];
          nb.exec(`INSERT OR IGNORE INTO ${table} SELECT * FROM old.${table}`);
          nb.prepare(
            `INSERT OR IGNORE INTO stream_settings (room, config_json, updated_at)
               SELECT room, config_json, updated_at FROM old.stream_settings WHERE model = ?`,
          ).run(model);
        } finally {
          nb.exec('DETACH old');
        }
      } catch (err) {
        this.logger.warn(
          `vision.db split for '${app}/${model}' failed: ${(err as Error).message}`,
        );
      }
    }
  }

  /**
   * Install the model-apps whose flag was true (occupancy defaults true),
   * carrying the shared knobs. Enabled = the model flag AND the vision plugin's
   * own enabled state. INSERT OR IGNORE — already-installed apps are left alone.
   */
  private installModelApps(
    app: string,
    cfg: Record<string, unknown>,
    visionEnabled: boolean,
  ): void {
    for (const model of VISION_MODELS) {
      const flag =
        model === 'occupancy'
          ? cfg[ENABLE_FLAG[model]] !== false // occupancy defaults ON
          : cfg[ENABLE_FLAG[model]] === true;
      if (!flag) continue;
      if (this.installs.get(app, model)) continue;
      const meta = this.registry.getMeta(model);
      if (!meta) continue;
      const carried: Record<string, unknown> = {
        device: cfg.device === 'cuda' ? 'cuda' : 'cpu',
        fps: typeof cfg.fps === 'number' ? cfg.fps : undefined,
        confidence: typeof cfg.confidence === 'number' ? cfg.confidence : undefined,
      };
      if (model === 'demography') {
        carried.engine = typeof cfg.engine === 'string' ? cfg.engine : undefined;
        carried.ai_api_key = typeof cfg.ai_api_key === 'string' ? cfg.ai_api_key : undefined;
      }
      // Drop undefined carried keys, then normalize against the model schema.
      const merged: Record<string, unknown> = { ...defaultConfig(meta) };
      for (const [k, v] of Object.entries(carried)) if (v !== undefined) merged[k] = v;
      let final: Record<string, unknown>;
      try {
        final = validateConfig(meta, merged, false);
      } catch {
        final = defaultConfig(meta);
      }
      const enabled = visionEnabled && flag;
      this.installs.install(app, model, final, enabled);
      // Carry the old vision worker's RUN INTENT so the boot-resume restarts the
      // migrated model-apps (detection stays on across the 2.16.0 deploy).
      this.installs.setWorkerDesired(app, model, enabled ? 'running' : 'stopped');
    }
  }

  /**
   * Re-point (or revoke) this app's `edge_assignments` rows that still carry the
   * old plugin_id 'vision': config_json.model gives the new per-model plugin_id;
   * an unknown/absent model is revoked so the edge reconcile recreates it.
   */
  private migrateAssignments(app: string): void {
    let rows: { id: string; config_json: string | null }[] = [];
    try {
      rows = this.db
        .global()
        .prepare(
          "SELECT id, config_json FROM edge_assignments WHERE app = ? AND plugin_id = 'vision'",
        )
        .all(app) as { id: string; config_json: string | null }[];
    } catch {
      return; // no edge_assignments table / no rows
    }
    for (const r of rows) {
      const model = this.assignmentModel(r.config_json);
      if (model) {
        this.db
          .global()
          .prepare(
            "UPDATE edge_assignments SET plugin_id = ?, updated_at = datetime('now') WHERE id = ?",
          )
          .run(model, r.id);
      } else {
        this.db
          .global()
          .prepare(
            "UPDATE edge_assignments SET status = 'revoked', updated_at = datetime('now') WHERE id = ?",
          )
          .run(r.id);
      }
    }
  }

  private assignmentModel(configJson: string | null): VisionModel | null {
    if (!configJson) return null;
    try {
      const parsed = JSON.parse(configJson) as { model?: unknown };
      return isVisionModel(parsed.model) ? parsed.model : null;
    } catch {
      return null;
    }
  }
}

/** Escape a filesystem path for use inside a single-quoted SQL string. */
function sqlPath(p: string): string {
  return p.replace(/'/g, "''");
}
