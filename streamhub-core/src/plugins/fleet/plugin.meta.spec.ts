/**
 * Unit spec — the fleet plugin manifest. Covers the discovery contract (id ===
 * folder, valid category/ui, no worker, version 0.1.0, every field defaulted)
 * and that the real auto-discovery registry picks it up.
 */
import fleet from './plugin.meta';
import { PluginRegistryService } from '../../modules/plugins/plugin-registry.service';
import { defaultConfig } from '../../modules/plugins/plugin-config.util';

describe('fleet plugin.meta', () => {
  it('has a valid, discoverable, worker-less manifest at 0.1.0', () => {
    expect(fleet.id).toBe('fleet');
    expect(fleet.category).toBe('tool');
    expect(fleet.ui).toBe('app-tab');
    expect(fleet.version).toBe('0.1.0');
    expect(fleet.needsWorker).not.toBe(true);
    expect(fleet.worker).toBeUndefined();
    // A fleet plugin emits no domain events (it is MQTT glue, not a worker).
    expect(fleet.events ?? []).toEqual([]);
  });

  it('exposes every option with a default (install-valid with no config)', () => {
    expect(fleet.configSchema.map((f) => f.key)).toEqual([
      'offlineAfterSec',
      'historyPoints',
      'commandTimeoutSec',
    ]);
    for (const f of fleet.configSchema) expect(f.default).not.toBeUndefined();
    expect(defaultConfig(fleet)).toEqual({
      offlineAfterSec: 90,
      historyPoints: 120,
      commandTimeoutSec: 30,
    });
  });

  it('is picked up by the real auto-discovery registry', () => {
    const reg = new PluginRegistryService();
    reg.discover();
    const manifest = reg.getManifest('fleet');
    expect(manifest?.ui).toBe('app-tab');
    expect(manifest?.needsWorker).toBe(false);
    expect(manifest?.version).toBe('0.1.0');
  });
});
