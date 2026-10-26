/**
 * Unit specs for VisionMigrationService — the vision → 4-apps boot migration.
 *
 * Runs against a real (temp) DB + a real registry + a seeded legacy vision.db.
 * Covers: installing only the enabled model-apps (occupancy defaults on), the
 * data split into per-model dbs, the edge_assignments re-point/revoke, the
 * removal of the old vision install, and IDEMPOTENCY on re-run.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';

import { makeUnitContext, type UnitContext } from '../../../test/helpers';
import { AppPluginsRepository } from '../plugins/app-plugins.repository';
import * as path from 'path';
import { PluginRegistryService } from '../plugins/plugin-registry.service';
import { VisionMigrationService } from './vision-migration.service';
import { VisionStore } from './vision.store';

const APP = 'live';

/** Seed a legacy vision.db (old single-file schema) with a few rows. */
function seedVisionDb(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE occupancy_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT NOT NULL, zone TEXT, tag TEXT,
      kind TEXT, node_id TEXT, started_at TEXT DEFAULT (datetime('now')), ended_at TEXT,
      duration_sec REAL, ts TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE count_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT NOT NULL, line TEXT, tag TEXT,
      direction TEXT, track_id TEXT, inside INTEGER, ts TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE crowd_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT NOT NULL, zone TEXT, tag TEXT,
      count INTEGER, threshold INTEGER, alert INTEGER NOT NULL DEFAULT 0, snapshot_url TEXT,
      ts TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE demography_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT NOT NULL, tag TEXT, age REAL,
      age_range TEXT, gender TEXT, emotion TEXT, engine TEXT,
      ts TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE stream_settings (
      room TEXT NOT NULL, model TEXT NOT NULL, config_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (room, model));
  `);
  db.prepare("INSERT INTO occupancy_sessions (room, zone) VALUES ('gate','z1')").run();
  db.prepare("INSERT INTO count_events (room, direction) VALUES ('gate','in')").run();
  db.prepare(
    "INSERT INTO stream_settings (room, model, config_json) VALUES ('gate','occupancy','{\"zones\":[]}')",
  ).run();
  db.prepare(
    "INSERT INTO stream_settings (room, model, config_json) VALUES ('gate','counting','{\"lines\":[],\"fps\":3.5}')",
  ).run();
  db.close();
}

const prevFixtureRoot = process.env.STREAMHUB_PLUGIN_FIXTURE_ROOT;
afterAll(() => {
  if (prevFixtureRoot === undefined) delete process.env.STREAMHUB_PLUGIN_FIXTURE_ROOT;
  else process.env.STREAMHUB_PLUGIN_FIXTURE_ROOT = prevFixtureRoot;
});

describe('VisionMigrationService', () => {
  let ctx: UnitContext;
  let appDir: string;
  let repo: AppPluginsRepository;
  let store: VisionStore;
  let svc: VisionMigrationService;

  beforeEach(() => {
    ctx = makeUnitContext();
    appDir = path.join(ctx.dataDir, 'apps', APP);
    ctx.mocks.apps.list.mockResolvedValue([{ name: APP }] as never);
    ctx.mocks.apps.appDir.mockImplementation(() => appDir);

    repo = new AppPluginsRepository(ctx.db);
    store = new VisionStore();
    // The 4 vision model-apps are DECOUPLED vendored apps — hermetic runs discover
    // their FIXTURE stand-ins (schema mirrors the migration-carried keys).
    process.env.STREAMHUB_PLUGIN_FIXTURE_ROOT = path.resolve(
      __dirname, '..', '..', '..', 'test', 'fixtures', 'plugins',
    );
    const registry = new PluginRegistryService();
    registry.discover();
    svc = new VisionMigrationService(
      ctx.db,
      repo,
      registry,
      store,
      ctx.mocks.apps,
      ctx.mocks.logs,
    );

    // Seed the legacy vision.db + a vision install with occupancy+counting on.
    seedVisionDb(path.join(appDir, 'vision', 'vision.db'));
    repo.install(
      APP,
      'vision',
      {
        occupancy_enabled: true,
        counting_enabled: true,
        crowd_enabled: false,
        demography_enabled: false,
        device: 'cuda',
        fps: 4,
        confidence: 0.5,
      },
      true,
    );
    // A vision edge_assignment that should re-point to its model, and one to revoke.
    ctx.db
      .global()
      .prepare(
        `INSERT INTO edge_assignments (id, node_id, app, plugin_id, stream_id, config_json, status)
           VALUES ('a1','n1',?,'vision','gate','{"model":"occupancy","room":"gate"}','running'),
                  ('a2','n1',?,'vision','x','{"room":"x"}','running')`,
      )
      .run(APP, APP);
  });

  afterEach(() => {
    store.onModuleDestroy();
    ctx.cleanup();
  });

  it('installs only the enabled model-apps (occupancy + counting), carrying config', async () => {
    await svc.migrate();

    const occ = repo.get(APP, 'occupancy');
    const cnt = repo.get(APP, 'counting');
    expect(occ?.enabled).toBe(true);
    expect(cnt?.enabled).toBe(true);
    // Carried the shared knobs.
    expect(occ?.config).toMatchObject({ device: 'cuda', fps: 4, confidence: 0.5 });
    // Disabled models were NOT installed.
    expect(repo.get(APP, 'crowd')).toBeNull();
    expect(repo.get(APP, 'demography')).toBeNull();
    // The old vision install is gone.
    expect(repo.get(APP, 'vision')).toBeNull();
  });

  it('marks the migrated enabled model-apps desired=running (detection resumes)', async () => {
    await svc.migrate();
    // occupancy + counting were enabled under vision → resume their workers.
    expect(repo.get(APP, 'occupancy')?.workerDesired).toBe('running');
    expect(repo.get(APP, 'counting')?.workerDesired).toBe('running');
  });

  it('splits the data into per-model dbs (events + settings)', async () => {
    await svc.migrate();
    expect(fs.existsSync(path.join(appDir, 'occupancy', 'occupancy.db'))).toBe(true);
    expect(store.recentEvents(APP, appDir, 'occupancy', 10)).toHaveLength(1);
    expect(store.recentEvents(APP, appDir, 'counting', 10)).toHaveLength(1);
    expect(store.getSetting(APP, appDir, 'occupancy', 'gate')?.config).toEqual({ zones: [] });
    expect(store.getSetting(APP, appDir, 'counting', 'gate')?.config).toEqual({
      lines: [],
      fps: 3.5,
    });
  });

  it('re-points a vision edge_assignment to its model and revokes an unknown one', async () => {
    await svc.migrate();
    const rows = ctx.db
      .global()
      .prepare('SELECT id, plugin_id, status FROM edge_assignments ORDER BY id')
      .all() as { id: string; plugin_id: string; status: string }[];
    expect(rows.find((r) => r.id === 'a1')).toMatchObject({
      plugin_id: 'occupancy',
      status: 'running',
    });
    expect(rows.find((r) => r.id === 'a2')).toMatchObject({
      plugin_id: 'vision',
      status: 'revoked',
    });
  });

  it('is idempotent: a re-run is a no-op (no duplicate installs / rows)', async () => {
    await svc.migrate();
    const occAfter1 = store.recentEvents(APP, appDir, 'occupancy', 10).length;
    await svc.migrate(); // re-run
    expect(repo.get(APP, 'vision')).toBeNull();
    expect(repo.get(APP, 'occupancy')?.enabled).toBe(true);
    // No duplicated event rows on the second pass.
    expect(store.recentEvents(APP, appDir, 'occupancy', 10)).toHaveLength(occAfter1);
  });

  it('backs up vision.db before splitting', async () => {
    await svc.migrate();
    expect(
      fs.existsSync(path.join(appDir, 'vision', 'vision.db.pre-split.bak')),
    ).toBe(true);
  });
});
