/**
 * Unit specs for the Timestamp CCTV built-in plugin meta.
 *
 * Verifies the manifest is well-formed against the SAME structural rules the
 * auto-discovery registry enforces, so a bad edit fails here (fast) rather than
 * being silently skipped at boot. Also proves the registry actually discovers
 * it from the real src/plugins root.
 */
import meta from './plugin.meta';
import { toManifest } from '../../modules/plugins/plugin.contract';
import { PluginRegistryService } from '../../modules/plugins/plugin-registry.service';

describe('timestamp plugin.meta', () => {
  it('is a client-side player-overlay tool (no worker)', () => {
    expect(meta.id).toBe('timestamp');
    expect(meta.category).toBe('tool');
    expect(meta.ui).toBe('player-overlay');
    expect(meta.needsWorker).toBeFalsy();
    expect(meta.worker).toBeUndefined();
  });

  it('exposes the documented config keys with sane defaults', () => {
    const byKey = Object.fromEntries(meta.configSchema.map((f) => [f.key, f]));
    expect(Object.keys(byKey).sort()).toEqual([
      'color',
      'format',
      'position',
      'showName',
    ]);

    // Every field has a default so an install with no config is valid.
    for (const f of meta.configSchema) {
      expect(f.default).toBeDefined();
    }

    expect(byKey.position.default).toBe('bottom-right');
    expect(byKey.showName.type).toBe('boolean');
    expect(byKey.showName.default).toBe(true);
  });

  it('select fields carry non-empty options and defaults that are valid choices', () => {
    for (const f of meta.configSchema) {
      if (f.type !== 'select') continue;
      expect(Array.isArray(f.options)).toBe(true);
      expect(f.options!.length).toBeGreaterThan(0);
      const values = f.options!.map((o) => o.value);
      expect(values).toContain(f.default);
    }
  });

  it('projects to a serializable manifest (no functions leak)', () => {
    const manifest = toManifest(meta);
    expect(manifest.needsWorker).toBe(false);
    expect((manifest as Record<string, unknown>).worker).toBeUndefined();
    expect(() => JSON.stringify(manifest)).not.toThrow();
  });

  it('is auto-discovered by the registry from the real plugins root', () => {
    const registry = new PluginRegistryService();
    registry.discover();
    const ids = registry.listManifests().map((m) => m.id);
    expect(ids).toContain('timestamp');

    const found = registry.getManifest('timestamp');
    expect(found?.ui).toBe('player-overlay');
    expect(found?.category).toBe('tool');
  });
});
