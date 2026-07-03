/**
 * Unit specs for the YOLO plugin manifest + its worker spawn spec.
 *
 * Covers the discovery contract (id === folder, valid category/ui, required
 * fields, worker present) and the pure `worker.spawn(ctx)` mapping (model-size →
 * weight name, cuda → device, config → env). No process is spawned.
 */
import yolo from './plugin.meta';
import { PluginRegistryService } from '../../modules/plugins/plugin-registry.service';
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

describe('yolo plugin.meta', () => {
  it('has a valid, discoverable manifest', () => {
    expect(yolo.id).toBe('yolo');
    expect(yolo.category).toBe('processor');
    expect(yolo.ui).toBe('player-overlay');
    expect(yolo.needsWorker).toBe(true);
    expect(typeof yolo.worker?.spawn).toBe('function');
  });

  it('exposes the required config fields with sane defaults', () => {
    const keys = yolo.configSchema.map((f) => f.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        'room',
        'model',
        'cuda',
        'callbackUrl',
        'confidence',
        'fps',
        'classes',
      ]),
    );
    const model = yolo.configSchema.find((f) => f.key === 'model');
    expect(model?.type).toBe('select');
    expect(model?.options?.map((o) => o.value)).toEqual([
      'nano',
      'small',
      'medium',
      'large',
      'xlarge',
    ]);
    const conf = yolo.configSchema.find((f) => f.key === 'confidence');
    expect(conf).toMatchObject({ type: 'number', min: 0, max: 1 });
    expect(
      yolo.configSchema.find((f) => f.key === 'callbackUrl')?.required,
    ).toBe(true);
    expect(yolo.configSchema.find((f) => f.key === 'room')?.required).toBe(true);
  });

  it('is picked up by the real auto-discovery registry', () => {
    const reg = new PluginRegistryService();
    reg.discover();
    expect(reg.getManifest('yolo')?.needsWorker).toBe(true);
  });

  it('spawns python with the mapped model + cpu device by default', () => {
    const spec = yolo.worker!.spawn(
      ctx({
        room: 'main',
        model: 'small',
        cuda: false,
        callbackUrl: 'https://hooks.test/yolo',
        confidence: 0.5,
        fps: 3,
        classes: 'person,car',
      }),
    );
    expect(spec.args).toEqual(['-m', 'yolo_worker', '--app', 'live']);
    expect(spec.env?.YOLO_MODEL).toBe('yolov8s');
    expect(spec.env?.YOLO_DEVICE).toBe('cpu');
    expect(spec.env?.YOLO_ROOM).toBe('main');
    expect(spec.env?.YOLO_CONFIDENCE).toBe('0.5');
    expect(spec.env?.YOLO_FPS).toBe('3');
    expect(spec.env?.YOLO_CLASSES).toBe('person,car');
    expect(spec.env?.YOLO_CALLBACK_URL).toBe('https://hooks.test/yolo');
    expect(spec.env?.YOLO_HLS_DIR).toBe('/data/apps/live/hls');
    // module is resolvable on PYTHONPATH
    expect(spec.env?.PYTHONPATH).toBe(spec.cwd);
  });

  it('maps model sizes to weights and cuda flag to device', () => {
    const dev = (cuda: unknown) =>
      yolo.worker!.spawn(ctx({ cuda, model: 'xlarge' })).env?.YOLO_DEVICE;
    expect(dev(true)).toBe('cuda');
    expect(dev('true')).toBe('cuda');
    expect(dev(false)).toBe('cpu');
    const weight = (model: string) =>
      yolo.worker!.spawn(ctx({ model })).env?.YOLO_MODEL;
    expect(weight('nano')).toBe('yolov8n');
    expect(weight('medium')).toBe('yolov8m');
    expect(weight('large')).toBe('yolov8l');
    expect(weight('xlarge')).toBe('yolov8x');
    // unknown → safe nano fallback
    expect(weight('bogus')).toBe('yolov8n');
  });
});
