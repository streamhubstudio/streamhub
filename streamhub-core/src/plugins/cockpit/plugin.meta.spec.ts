/**
 * Unit specs for the Cockpit built-in plugin meta.
 *
 * Proves (a) the manifest is well-formed and auto-discovered by the real
 * registry (glob → src/plugins/cockpit/plugin.meta.ts) and (b) its config
 * schema has sane, validated defaults so a zero-config install is valid.
 */
import cockpit from './plugin.meta';
import { toManifest } from '../../modules/plugins/plugin.contract';
import { PluginRegistryService } from '../../modules/plugins/plugin-registry.service';

describe('Cockpit plugin.meta', () => {
  it('has the expected identity + placement', () => {
    expect(cockpit.id).toBe('cockpit');
    expect(cockpit.name).toBe('Cockpit');
    expect(cockpit.category).toBe('panel');
    expect(cockpit.ui).toBe('panel');
    expect(cockpit.needsWorker).not.toBe(true);
  });

  it('is a pure/serializable manifest (no worker closure)', () => {
    const manifest = toManifest(cockpit);
    expect(manifest.needsWorker).toBe(false);
    expect(() => JSON.stringify(manifest)).not.toThrow();
    expect(manifest.version).toBe('1.0.0');
  });

  it('exposes the documented config fields with defaults', () => {
    const byKey = Object.fromEntries(
      cockpit.configSchema.map((f) => [f.key, f]),
    );
    // Every field MUST carry a default (contract) so an unconfigured install
    // is immediately usable.
    for (const field of cockpit.configSchema) {
      expect(field.default).not.toBeUndefined();
    }
    expect(byKey.gridSize.type).toBe('select');
    expect(byKey.gridSize.default).toBe('4x3');
    expect(byKey.gridSize.options?.map((o) => o.value)).toEqual([
      '1x1',
      '2x2',
      '3x3',
      '4x3',
    ]);
    expect(byKey.autoPlay.type).toBe('boolean');
    expect(byKey.autoPlay.default).toBe(true);
    expect(byKey.showLabels.type).toBe('boolean');
    expect(byKey.showLabels.default).toBe(true);
    expect(byKey.refreshSeconds.type).toBe('number');
    expect(byKey.refreshSeconds.min).toBe(3);
    expect(byKey.refreshSeconds.max).toBe(300);
  });

  it('is discovered by the real plugin registry', () => {
    const registry = new PluginRegistryService();
    registry.discover();
    const manifest = registry.getManifest('cockpit');
    expect(manifest).toBeDefined();
    expect(manifest?.ui).toBe('panel');
    expect(manifest?.needsWorker).toBe(false);
  });
});
