/**
 * Unit spec — the stream-health Studio App manifest. Covers the discovery
 * contract (id === folder, app kind, worker + storage + event declarations,
 * every config field defaulted), the PURE spawn builder on the local path
 * (env layout, worker-dir override) and that the real auto-discovery registry
 * picks it up.
 */
import streamHealth, { healthWorkerDir } from './plugin.meta';
import { PluginRegistryService } from '../../modules/plugins/plugin-registry.service';
import { defaultConfig } from '../../modules/plugins/plugin-config.util';
import type { PluginWorkerContext } from '../../modules/plugins/plugin.contract';

const ctx: PluginWorkerContext = {
  app: 'live',
  config: { sample_interval_sec: 5, silence_db: -40 },
  appDir: '/data/apps/live',
  dataDir: '/data',
  livekitUrl: 'ws://127.0.0.1:7880',
};

describe('stream-health plugin.meta', () => {
  it('is a worker-backed Studio App with its own storage at 0.1.0', () => {
    expect(streamHealth.id).toBe('stream-health');
    expect(streamHealth.kind).toBe('app');
    expect(streamHealth.category).toBe('processor');
    expect(streamHealth.ui).toBe('app-tab');
    expect(streamHealth.version).toBe('0.1.0');
    expect(streamHealth.needsWorker).toBe(true);
    expect(streamHealth.storage).toEqual({ db: 'stream-health.db' });
    expect(streamHealth.events).toEqual([
      'health.degraded',
      'health.recovered',
      'health.audio_lost',
      'health.audio_recovered',
      'health.av_desync',
      'health.stalled',
      'health.discontinuity',
    ]);
  });

  it('exposes every threshold with a default (install-valid with no config)', () => {
    for (const f of streamHealth.configSchema) {
      expect(f.default).not.toBeUndefined();
    }
    expect(defaultConfig(streamHealth)).toEqual({
      sample_interval_sec: 10,
      silence_db: -50,
      silence_duration_sec: 15,
      desync_ms: 200,
      stall_sec: 20,
      bitrate_drop_pct: 50,
      recover_samples: 2,
    });
  });

  it('spawns the Node worker against the app HLS dir with the config baked', () => {
    const spec = streamHealth.worker!.spawn(ctx);
    expect(spec.command).toBe(process.env.PLUGIN_NODE ?? process.execPath);
    expect(spec.args?.[0].endsWith('/src/main.js')).toBe(true);
    expect(spec.cwd).toBe(healthWorkerDir());
    expect(spec.env).toEqual({
      HEALTH_APP: 'live',
      HEALTH_HLS_DIR: '/data/apps/live/hls',
      HEALTH_DATA_DIR: '/data/apps/live/stream-health',
      HEALTH_CONFIG_JSON: JSON.stringify({
        sample_interval_sec: 5,
        silence_db: -40,
      }),
    });
  });

  it('honors the HEALTH_WORKER_DIR override', () => {
    const prev = process.env.HEALTH_WORKER_DIR;
    process.env.HEALTH_WORKER_DIR = '/opt/workers/health-worker';
    try {
      expect(healthWorkerDir()).toBe('/opt/workers/health-worker');
      const spec = streamHealth.worker!.spawn(ctx);
      expect(spec.args?.[0]).toBe('/opt/workers/health-worker/src/main.js');
      expect(spec.cwd).toBe('/opt/workers/health-worker');
    } finally {
      if (prev === undefined) delete process.env.HEALTH_WORKER_DIR;
      else process.env.HEALTH_WORKER_DIR = prev;
    }
  });

  it('is picked up by the real auto-discovery registry as an app', () => {
    const reg = new PluginRegistryService();
    reg.discover();
    const m = reg.getManifest('stream-health');
    expect(m?.kind).toBe('app');
    expect(m?.needsWorker).toBe(true);
    expect(m?.events).toContain('health.degraded');
  });
});
