/**
 * Unit specs for the Scheduled Live built-in plugin meta.
 *
 * Verifies the manifest is well-formed against the SAME structural rules the
 * auto-discovery registry enforces, so a bad edit fails here (fast) rather than
 * being silently skipped at boot. Also proves the registry actually discovers
 * it from the real src/plugins root.
 */
import meta from './plugin.meta';
import { toManifest } from '../../modules/plugins/plugin.contract';
import { PluginRegistryService } from '../../modules/plugins/plugin-registry.service';

describe('scheduled-live plugin.meta', () => {
  it('is a client-side player-overlay tool (no worker)', () => {
    expect(meta.id).toBe('scheduled-live');
    expect(meta.category).toBe('tool');
    expect(meta.ui).toBe('player-overlay');
    expect(meta.needsWorker).toBeFalsy();
    expect(meta.worker).toBeUndefined();
  });

  it('exposes the documented config keys with sane defaults', () => {
    const byKey = Object.fromEntries(meta.configSchema.map((f) => [f.key, f]));
    expect(Object.keys(byKey).sort()).toEqual([
      'accent',
      'autoHideAfterStartSec',
      'headline',
      'mode',
      'muteUntilStart',
      'revealAnimation',
      'showViewerLocalTime',
    ]);

    // Every field has a default so an install with no config is valid.
    for (const f of meta.configSchema) {
      expect(f.default).toBeDefined();
    }

    expect(byKey.mode.default).toBe('cover');
    expect(byKey.muteUntilStart.type).toBe('boolean');
    expect(byKey.muteUntilStart.default).toBe(true);
    expect(byKey.autoHideAfterStartSec.type).toBe('number');
    expect(byKey.autoHideAfterStartSec.min).toBe(0);
    expect(byKey.autoHideAfterStartSec.max).toBe(60);
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
    expect(ids).toContain('scheduled-live');

    const found = registry.getManifest('scheduled-live');
    expect(found?.ui).toBe('player-overlay');
    expect(found?.category).toBe('tool');
  });
});
