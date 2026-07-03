/**
 * Unit specs for the Quality / Stream Health built-in plugin meta.
 *
 * Proves (a) the manifest is well-formed and auto-discovered by the real
 * registry (glob → src/plugins/quality/plugin.meta.ts) and (b) its threshold
 * schema has sane, validated defaults so a zero-config install is valid.
 */
import quality from './plugin.meta';
import { toManifest } from '../../modules/plugins/plugin.contract';
import { PluginRegistryService } from '../../modules/plugins/plugin-registry.service';

describe('Quality plugin.meta', () => {
  it('has the expected identity + placement (no worker)', () => {
    expect(quality.id).toBe('quality');
    expect(quality.name).toBe('Quality / Stream Health');
    expect(quality.category).toBe('tool');
    expect(quality.ui).toBe('panel');
    expect(quality.needsWorker).not.toBe(true);
    expect(quality.worker).toBeUndefined();
  });

  it('is a pure/serializable manifest (no worker closure)', () => {
    const manifest = toManifest(quality);
    expect(manifest.needsWorker).toBe(false);
    expect((manifest as Record<string, unknown>).worker).toBeUndefined();
    expect(() => JSON.stringify(manifest)).not.toThrow();
    expect(manifest.version).toBe('1.0.0');
  });

  it('exposes the documented threshold fields with sane defaults', () => {
    const byKey = Object.fromEntries(
      quality.configSchema.map((f) => [f.key, f]),
    );

    // Every field MUST carry a default (contract) so an unconfigured install
    // is immediately usable.
    for (const field of quality.configSchema) {
      expect(field.default).not.toBeUndefined();
    }

    expect(byKey.green_min_mbps.type).toBe('number');
    expect(byKey.green_min_mbps.default).toBe(5);
    expect(byKey.yellow_min_mbps.type).toBe('number');
    expect(byKey.yellow_min_mbps.default).toBe(1);
    expect(byKey.target_bitrate_kbps.type).toBe('number');
    expect(byKey.target_bitrate_kbps.default).toBe(2500);

    // The amber floor must sit below the green floor for a coherent ladder.
    expect(
      Number(byKey.yellow_min_mbps.default),
    ).toBeLessThan(Number(byKey.green_min_mbps.default));
  });

  it('numeric fields declare inclusive bounds that contain their default', () => {
    for (const f of quality.configSchema) {
      if (f.type !== 'number') continue;
      const def = Number(f.default);
      if (typeof f.min === 'number') expect(def).toBeGreaterThanOrEqual(f.min);
      if (typeof f.max === 'number') expect(def).toBeLessThanOrEqual(f.max);
    }
  });

  it('is auto-discovered by the real plugin registry', () => {
    const registry = new PluginRegistryService();
    registry.discover();
    const manifest = registry.getManifest('quality');
    expect(manifest).toBeDefined();
    expect(manifest?.ui).toBe('panel');
    expect(manifest?.category).toBe('tool');
    expect(manifest?.needsWorker).toBe(false);
  });
});
