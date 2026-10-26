/**
 * Unit specs for the plugin contract projection (`toManifest`) — the version
 * surfacing + back-compat fallback added for plugin versioning.
 */
import { PluginMeta, definePlugin, toManifest } from './plugin.contract';

const base: PluginMeta = {
  id: 'demo',
  name: 'Demo',
  description: 'A demo plugin.',
  category: 'panel',
  ui: 'panel',
  version: '2.3.1',
  configSchema: [],
};

describe('plugin.contract — toManifest version', () => {
  it('surfaces the declared version on the manifest', () => {
    expect(toManifest(base).version).toBe('2.3.1');
  });

  it('defaults a missing version to 0.0.0 (back-compat, never breaks)', () => {
    // A manifest loaded off disk may lack a version (third-party). Cast away the
    // now-REQUIRED field to simulate that runtime shape.
    const noVersion = { ...base } as Partial<PluginMeta>;
    delete noVersion.version;
    expect(toManifest(noVersion as PluginMeta).version).toBe('0.0.0');
  });

  it('carries a prerelease/build semver through unchanged', () => {
    expect(toManifest({ ...base, version: '0.1.0' }).version).toBe('0.1.0');
    expect(toManifest({ ...base, version: '1.0.0-beta.1' }).version).toBe(
      '1.0.0-beta.1',
    );
  });

  it('definePlugin returns the meta unchanged (identity, keeps version)', () => {
    const meta = definePlugin(base);
    expect(meta).toBe(base);
    expect(meta.version).toBe('2.3.1');
  });
});

describe('plugin.contract — toManifest taxonomy (kind/storage/exportable)', () => {
  it('defaults an omitted kind to plugin, with no storage + not exportable', () => {
    const m = toManifest(base);
    expect(m.kind).toBe('plugin');
    expect(m.storage).toBeNull();
    expect(m.exportable).toBe(false);
  });

  it('projects kind and storage.db for a Studio App', () => {
    const m = toManifest({
      ...base,
      kind: 'app',
      storage: { db: 'lpr.db' },
    });
    expect(m.kind).toBe('app');
    expect(m.storage).toEqual({ db: 'lpr.db' });
  });

  it('marks an app exportable only when export names a workerDir', () => {
    expect(toManifest({ ...base, kind: 'app' }).exportable).toBe(false);
    expect(
      toManifest({ ...base, kind: 'app', export: {} }).exportable,
    ).toBe(false);
    expect(
      toManifest({ ...base, kind: 'app', export: { workerDir: 'lpr-worker' } })
        .exportable,
    ).toBe(true);
  });

  it('stays JSON-serializable with the new fields', () => {
    const m = toManifest({
      ...base,
      kind: 'app',
      storage: { db: 'x.db' },
      export: { workerDir: 'x-worker' },
    });
    expect(() => JSON.stringify(m)).not.toThrow();
    // The export descriptor closure/object never leaks the meta's `export`.
    expect((m as Record<string, unknown>).export).toBeUndefined();
  });
});
