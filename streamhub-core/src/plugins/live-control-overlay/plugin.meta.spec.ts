/**
 * Unit specs for the Live Control Overlay built-in plugin meta.
 */
import meta from './plugin.meta';
import { toManifest } from '../../modules/plugins/plugin.contract';
import { PluginRegistryService } from '../../modules/plugins/plugin-registry.service';

describe('live-control-overlay plugin.meta', () => {
  it('is a client-side player-overlay tool (no worker, no storage)', () => {
    expect(meta.id).toBe('live-control-overlay');
    expect(meta.category).toBe('tool');
    expect(meta.ui).toBe('player-overlay');
    expect(meta.needsWorker).toBeFalsy();
    expect(meta.worker).toBeUndefined();
    expect(meta.storage).toBeUndefined();
  });

  it('every config field has a default; selects default to a valid option', () => {
    for (const f of meta.configSchema) {
      expect(f.default).toBeDefined();
      if (f.type === 'select') {
        expect(f.options!.map((o) => o.value)).toContain(f.default);
      }
    }
  });

  it('projects to a serializable manifest and is auto-discovered', () => {
    const manifest = toManifest(meta);
    expect(manifest.ui).toBe('player-overlay');
    expect(() => JSON.stringify(manifest)).not.toThrow();

    const registry = new PluginRegistryService();
    registry.discover();
    expect(registry.getManifest('live-control-overlay')?.ui).toBe('player-overlay');
  });
});
