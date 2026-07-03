/**
 * Unit spec for the built-in Video Streaming plugin manifest.
 *
 * Verifies structural validity + real auto-discovery from the shipped
 * src/plugins root.
 */
import meta from './plugin.meta';
import { PluginRegistryService } from '../../modules/plugins/plugin-registry.service';

describe('streaming plugin.meta', () => {
  it('is a no-worker tool with a default studio room', () => {
    expect(meta.id).toBe('streaming');
    expect(meta.category).toBe('tool');
    expect(meta.ui).toBe('app-tab');
    expect(meta.needsWorker).toBeFalsy();
    expect(meta.worker).toBeUndefined();

    const room = meta.configSchema.find((f) => f.key === 'room');
    expect(room?.default).toBe('studio');

    const rtmp = meta.configSchema.find((f) => f.key === 'defaultRtmpUrl');
    expect(rtmp?.type).toBe('string');
    expect(rtmp?.default).toBe('');

    const audioOnly = meta.configSchema.find((f) => f.key === 'audioOnly');
    expect(audioOnly?.type).toBe('boolean');
    expect(audioOnly?.default).toBe(false);
  });

  it('every config field has a default (installable with no config)', () => {
    for (const f of meta.configSchema) {
      expect(f.default).not.toBeUndefined();
    }
  });

  it('is auto-discovered from the shipped plugins root', () => {
    const registry = new PluginRegistryService();
    registry.discover();
    expect(registry.has('streaming')).toBe(true);

    const manifest = registry.getManifest('streaming');
    expect(manifest?.category).toBe('tool');
    expect(manifest?.needsWorker).toBe(false);
    expect(() => JSON.stringify(manifest)).not.toThrow();
  });
});
