/**
 * Unit spec for the built-in Radio plugin manifest.
 *
 * Verifies (a) the manifest is structurally valid, and (b) it is actually
 * auto-discovered by the real PluginRegistryService from the shipped
 * src/plugins root (no central registration).
 */
import meta from './plugin.meta';
import { PluginRegistryService } from '../../modules/plugins/plugin-registry.service';

describe('radio plugin.meta', () => {
  it('is a no-worker app-tab panel with a sensible default room', () => {
    expect(meta.id).toBe('radio');
    expect(meta.category).toBe('panel');
    expect(meta.ui).toBe('app-tab');
    expect(meta.needsWorker).toBeFalsy();
    expect(meta.worker).toBeUndefined();

    const room = meta.configSchema.find((f) => f.key === 'room');
    expect(room?.type).toBe('string');
    expect(room?.default).toBe('radio');

    const ttl = meta.configSchema.find((f) => f.key === 'listenTokenTtlSeconds');
    expect(ttl?.type).toBe('number');
    expect(ttl?.default).toBe(3600);
  });

  it('every config field has a default (installable with no config)', () => {
    for (const f of meta.configSchema) {
      expect(f.default).not.toBeUndefined();
    }
  });

  it('is auto-discovered from the shipped plugins root', () => {
    const registry = new PluginRegistryService();
    registry.discover();
    expect(registry.has('radio')).toBe(true);

    const manifest = registry.getManifest('radio');
    expect(manifest?.needsWorker).toBe(false);
    expect(() => JSON.stringify(manifest)).not.toThrow();
  });
});
