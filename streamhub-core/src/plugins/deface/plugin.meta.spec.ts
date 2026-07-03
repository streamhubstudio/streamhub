/**
 * Unit specs for the deface plugin manifest + its worker spawn spec.
 *
 * Covers the discovery contract (id === folder, valid category/ui, every field
 * defaulted, worker present) and the pure `worker.spawn(ctx)` mapping
 * (config → DEFACE_* env, cuda → execution provider, model/HLS paths).
 * No process is spawned.
 */
import deface from './plugin.meta';
import { PluginRegistryService } from '../../modules/plugins/plugin-registry.service';
import { defaultConfig } from '../../modules/plugins/plugin-config.util';
import type { PluginWorkerContext } from '../../modules/plugins/plugin.contract';

function ctx(config: Record<string, unknown>): PluginWorkerContext {
  return {
    app: 'live',
    config,
    appDir: '/data/apps/live',
    dataDir: '/data',
    livekitUrl: 'ws://127.0.0.1:7880',
  };
}

describe('deface plugin.meta', () => {
  it('has a valid, discoverable manifest', () => {
    expect(deface.id).toBe('deface');
    expect(deface.category).toBe('processor');
    expect(deface.ui).toBe('player-overlay');
    expect(deface.needsWorker).toBe(true);
    expect(typeof deface.worker?.spawn).toBe('function');
  });

  it('exposes every deface option with a default (install-valid with no config)', () => {
    const keys = deface.configSchema.map((f) => f.key);
    expect(keys).toEqual([
      'room',
      'thresh',
      'replacewith',
      'maskScale',
      'boxes',
      'mosaicSize',
      'scale',
      'backend',
      'cuda',
      'fps',
      'drawScores',
    ]);
    for (const f of deface.configSchema) {
      expect(f.default).not.toBeUndefined();
    }
    // A fresh install (defaults only) validates without throwing.
    expect(defaultConfig(deface)).toMatchObject({
      room: '',
      thresh: 0.2,
      replacewith: 'blur',
      maskScale: 1.3,
      boxes: false,
      mosaicSize: 20,
      scale: '',
      backend: 'auto',
      cuda: false,
      fps: 2,
      drawScores: false,
    });
  });

  it('constrains the option fields like the deface CLI', () => {
    const field = (k: string) => deface.configSchema.find((f) => f.key === k);
    expect(field('room')?.required).toBe(true);
    expect(field('thresh')).toMatchObject({ type: 'number', min: 0, max: 1 });
    expect(field('replacewith')?.options?.map((o) => o.value)).toEqual([
      'blur',
      'mosaic',
      'solid',
      'none',
    ]);
    expect(field('backend')?.options?.map((o) => o.value)).toEqual([
      'auto',
      'onnxrt',
      'opencv',
    ]);
    expect(field('fps')).toMatchObject({ type: 'number', min: 0.1, max: 30 });
    expect(field('boxes')?.type).toBe('boolean');
    expect(field('cuda')?.type).toBe('boolean');
    expect(field('drawScores')?.type).toBe('boolean');
  });

  it('is picked up by the real auto-discovery registry', () => {
    const reg = new PluginRegistryService();
    reg.discover();
    expect(reg.getManifest('deface')?.needsWorker).toBe(true);
    expect(reg.getManifest('deface')?.ui).toBe('player-overlay');
  });

  it('spawns python -m deface_worker with the config mapped to DEFACE_* env', () => {
    const spec = deface.worker!.spawn(
      ctx({
        room: 'main',
        thresh: 0.35,
        replacewith: 'mosaic',
        maskScale: 1.5,
        boxes: true,
        mosaicSize: 12,
        scale: '640x360',
        backend: 'onnxrt',
        cuda: false,
        fps: 4,
        drawScores: true,
      }),
    );
    expect(spec.args).toEqual(['-m', 'deface_worker', '--app', 'live']);
    expect(spec.env?.DEFACE_ROOM).toBe('main');
    expect(spec.env?.DEFACE_THRESH).toBe('0.35');
    expect(spec.env?.DEFACE_MASK_SCALE).toBe('1.5');
    expect(spec.env?.DEFACE_SCALE).toBe('640x360');
    expect(spec.env?.DEFACE_BACKEND).toBe('onnxrt');
    expect(spec.env?.DEFACE_EXECUTION_PROVIDER).toBe('cpu');
    expect(spec.env?.DEFACE_FPS).toBe('4');
    expect(spec.env?.DEFACE_HLS_DIR).toBe('/data/apps/live/hls');
    expect(spec.env?.DEFACE_MODEL_DIR).toBe('/data/models/deface');
    expect(spec.env?.DEFACE_LIVEKIT_URL).toBe('ws://127.0.0.1:7880');
    // module is resolvable on PYTHONPATH
    expect(spec.env?.PYTHONPATH).toBe(spec.cwd);
    // render-side options (replacewith/boxes/mosaicSize/drawScores) are NOT
    // worker env — the player overlay reads them from the public config.
    expect(Object.keys(spec.env ?? {})).not.toEqual(
      expect.arrayContaining(['DEFACE_REPLACEWITH', 'DEFACE_BOXES']),
    );
  });

  it('maps the cuda toggle to the execution provider', () => {
    const provider = (cuda: unknown) =>
      deface.worker!.spawn(ctx({ cuda })).env?.DEFACE_EXECUTION_PROVIDER;
    expect(provider(true)).toBe('cuda');
    expect(provider('true')).toBe('cuda');
    expect(provider(false)).toBe('cpu');
    expect(provider(undefined)).toBe('cpu');
  });

  it('respects DEFACE_WORKER_DIR / PLUGIN_PYTHON operator overrides', () => {
    const prevDir = process.env.DEFACE_WORKER_DIR;
    const prevPy = process.env.PLUGIN_PYTHON;
    process.env.DEFACE_WORKER_DIR = '/opt/deface-worker';
    process.env.PLUGIN_PYTHON = '/usr/bin/python3.12';
    try {
      const spec = deface.worker!.spawn(ctx({}));
      expect(spec.cwd).toBe('/opt/deface-worker');
      expect(spec.command).toBe('/usr/bin/python3.12');
    } finally {
      if (prevDir === undefined) delete process.env.DEFACE_WORKER_DIR;
      else process.env.DEFACE_WORKER_DIR = prevDir;
      if (prevPy === undefined) delete process.env.PLUGIN_PYTHON;
      else process.env.PLUGIN_PYTHON = prevPy;
    }
  });
});
