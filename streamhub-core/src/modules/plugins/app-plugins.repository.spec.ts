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
});
