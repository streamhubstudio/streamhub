/**
 * Unit specs for the Live Control (console) built-in plugin meta.
 *
 * Locks the manifest against the SAME structural rules the auto-discovery
 * registry enforces so a bad edit fails fast, and proves it is discovered.
 */
import meta from './plugin.meta';
import { toManifest } from '../../modules/plugins/plugin.contract';
import { PluginRegistryService } from '../../modules/plugins/plugin-registry.service';

describe('live-control plugin.meta', () => {
  it('is a Studio App (app-tab, kind app, own storage db, no worker)', () => {
    expect(meta.id).toBe('live-control');
    expect(meta.category).toBe('tool');
    expect(meta.ui).toBe('app-tab');
    expect(meta.kind).toBe('app');
    expect(meta.storage?.db).toBe('live-control.db');
    expect(meta.needsWorker).toBeFalsy();
    expect(meta.worker).toBeUndefined();
  });

  it('declares the three livecontrol.* funnel events', () => {
    expect(meta.events).toEqual([
      'livecontrol.paused',
      'livecontrol.resumed',
      'livecontrol.finished',
    ]);
  });

  it('exposes the per-app default config keys, every field defaulted', () => {
    const byKey = Object.fromEntries(meta.configSchema.map((f) => [f.key, f]));
    expect(Object.keys(byKey).sort()).toEqual([
      'defaultCardColor',
      'defaultCardText',
      'defaultCardTitle',
      'defaultMode',
      'muteAudioServerSide',
      'pollSeconds',
    ]);
    for (const f of meta.configSchema) expect(f.default).toBeDefined();
    expect(byKey.defaultMode.default).toBe('text');
    expect(byKey.muteAudioServerSide.default).toBe(true);
    expect(byKey.pollSeconds.type).toBe('number');
    expect(byKey.pollSeconds.min).toBe(2);
    expect(byKey.pollSeconds.max).toBe(60);
  });

  it('select fields carry non-empty options whose default is a valid choice', () => {
    for (const f of meta.configSchema) {
      if (f.type !== 'select') continue;
      expect(Array.isArray(f.options)).toBe(true);
      expect(f.options!.length).toBeGreaterThan(0);
      expect(f.options!.map((o) => o.value)).toContain(f.default);
    }
  });

  it('projects to a serializable manifest (exportable false, events preserved)', () => {
    const manifest = toManifest(meta);
    expect(manifest.kind).toBe('app');
    expect(manifest.exportable).toBe(false);
    expect(manifest.storage).toEqual({ db: 'live-control.db' });
    expect(manifest.events).toContain('livecontrol.paused');
    expect(() => JSON.stringify(manifest)).not.toThrow();
  });

  it('is auto-discovered by the registry from the real plugins root', () => {
    const registry = new PluginRegistryService();
    registry.discover();
    const found = registry.getManifest('live-control');
    expect(found?.ui).toBe('app-tab');
    expect(found?.kind).toBe('app');
  });
});
