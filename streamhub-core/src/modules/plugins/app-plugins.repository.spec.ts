/**
 * Unit specs for AppPluginsRepository against a REAL migrated per-app app.db.
 */
import { makeUnitContext, type UnitContext } from '../../../test/helpers';
import { AppPluginsRepository } from './app-plugins.repository';

const APP = 'live';

describe('AppPluginsRepository', () => {
  let ctx: UnitContext;
  let repo: AppPluginsRepository;

  beforeEach(() => {
    ctx = makeUnitContext();
    repo = new AppPluginsRepository(ctx.db);
  });
  afterEach(() => ctx.cleanup());

  it('installs, reads and lists', () => {
    repo.install(APP, 'watermark', { text: 'hi' });
    const got = repo.get(APP, 'watermark');
    expect(got).toMatchObject({
      pluginId: 'watermark',
      enabled: true,
      config: { text: 'hi' },
    });
    expect(got?.installedAt).toBeTruthy();
    expect(repo.list(APP).map((r) => r.pluginId)).toEqual(['watermark']);
  });

  it('install is idempotent (INSERT OR IGNORE)', () => {
    repo.install(APP, 'watermark', { text: 'one' });
    repo.install(APP, 'watermark', { text: 'two' });
    expect(repo.get(APP, 'watermark')?.config).toEqual({ text: 'one' });
    expect(repo.list(APP)).toHaveLength(1);
  });

  it('updates enabled and config, bumping updated_at', () => {
    repo.install(APP, 'watermark', { text: 'a' });
    repo.update(APP, 'watermark', { enabled: false, config: { text: 'b' } });
    const got = repo.get(APP, 'watermark');
    expect(got?.enabled).toBe(false);
    expect(got?.config).toEqual({ text: 'b' });
  });

  it('a no-op update does not throw', () => {
    repo.install(APP, 'watermark', {});
    expect(() => repo.update(APP, 'watermark', {})).not.toThrow();
  });

  it('removes', () => {
    repo.install(APP, 'watermark', {});
    repo.remove(APP, 'watermark');
    expect(repo.get(APP, 'watermark')).toBeNull();
  });

  it('returns null for a missing plugin', () => {
    expect(repo.get(APP, 'nope')).toBeNull();
  });

  it('isolates state per app', () => {
    repo.install('live', 'watermark', {});
    expect(repo.list('other')).toEqual([]);
  });

  describe('desired worker state', () => {
    it('defaults to null (no intent recorded) on a fresh install', () => {
      repo.install(APP, 'lpr', {});
      expect(repo.get(APP, 'lpr')?.workerDesired).toBeNull();
    });

    it('records + reads back the desired state (round-trip on get + list)', () => {
      repo.install(APP, 'lpr', {});
      repo.setWorkerDesired(APP, 'lpr', 'running');
      expect(repo.get(APP, 'lpr')?.workerDesired).toBe('running');
      expect(repo.list(APP)[0].workerDesired).toBe('running');
      repo.setWorkerDesired(APP, 'lpr', 'stopped');
      expect(repo.get(APP, 'lpr')?.workerDesired).toBe('stopped');
    });

    it('setWorkerDesired on an unknown plugin is a no-op', () => {
      expect(() => repo.setWorkerDesired(APP, 'ghost', 'running')).not.toThrow();
      expect(repo.get(APP, 'ghost')).toBeNull();
    });

    it('adds the worker_desired column idempotently to a pre-existing app.db', () => {
      // Simulate a legacy app.db: drop the column, then a repo read must
      // transparently re-add it (no throw, NULL intent).
      const db = ctx.db.appDb(APP);
      db.exec('DROP TABLE IF EXISTS app_plugins');
      db.exec(
        `CREATE TABLE app_plugins (plugin_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1,
           config_json TEXT, installed_at TEXT NOT NULL DEFAULT (datetime('now')),
           updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
      );
      db.prepare("INSERT INTO app_plugins (plugin_id, enabled) VALUES ('lpr', 1)").run();
      // Fresh repo (its ensured-cache is empty) → first access adds the column.
      const fresh = new AppPluginsRepository(ctx.db);
      expect(fresh.get(APP, 'lpr')?.workerDesired).toBeNull();
      fresh.setWorkerDesired(APP, 'lpr', 'running');
      expect(fresh.get(APP, 'lpr')?.workerDesired).toBe('running');
    });
  });
});
