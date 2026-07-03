/**
 * Unit spec — HwAccelService (system module, hwaccel resolution + SDK options).
 *
 * Exercises the per-app sidecar preference (get/set), the auto/gpu/cpu × GPU-
 * availability decision matrix, the SDK option builders (egress EncodingOptions
 * / ingress IngressVideoOptions), and the metrics hook. GpuService + Metrics are
 * fakes; the sidecar lands in the suite's temp DATA_DIR.
 *
 * Owned by the transcoding/GPU agent. Touches only this *.spec.ts.
 */
import * as fs from 'fs';
import * as path from 'path';
import { VideoCodec } from '@livekit/protocol';

import { HwAccelService } from './hwaccel.service';
import { GpuService } from './gpu.service';
import { GpuStatus } from './gpu.types';
import { makeTestConfig, mockLogsService } from '../../../test/helpers';
import { ConfigService } from '../../shared/config/config.service';

function gpuFake(status: Partial<GpuStatus>): GpuService {
  const full: GpuStatus = {
    available: false,
    type: 'none',
    devices: [],
    checkedAt: new Date().toISOString(),
    ...status,
  };
  return { status: jest.fn(async () => full) } as unknown as GpuService;
}

interface Built {
  svc: HwAccelService;
  config: ConfigService;
  dataDir: string;
  metrics: { recordTranscode: jest.Mock; setGpuAvailable: jest.Mock };
}

function build(gpu: GpuService, dataDir?: string): Built {
  const { config, dataDir: dir } = makeTestConfig(
    dataDir ? { DATA_DIR: dataDir } : {},
  );
  const metrics = {
    recordTranscode: jest.fn(),
    setGpuAvailable: jest.fn(),
  };
  const svc = new HwAccelService(
    config,
    gpu,
    mockLogsService(),
    metrics as never,
  );
  return { svc, config, dataDir: dir, metrics };
}

describe('HwAccelService', () => {
  afterEach(() => {
    delete process.env.TRANSCODING_HWACCEL;
    jest.clearAllMocks();
  });

  // --- per-app sidecar preference ------------------------------------------
  describe('getMode / setMode', () => {
    it('defaults to auto with no sidecar and no env', () => {
      const { svc } = build(gpuFake({}));
      expect(svc.getMode('live')).toBe('auto');
    });

    it('honours the TRANSCODING_HWACCEL default', () => {
      process.env.TRANSCODING_HWACCEL = 'cpu';
      const { svc } = build(gpuFake({}));
      expect(svc.getMode('live')).toBe('cpu');
    });

    it('persists + reads back a per-app mode via the sidecar', () => {
      const { svc, dataDir } = build(gpuFake({}));
      expect(svc.setMode('live', 'gpu')).toBe('gpu');
      expect(svc.getMode('live')).toBe('gpu');
      const sidecar = path.join(dataDir, 'apps', 'live', 'transcoding.json');
      expect(JSON.parse(fs.readFileSync(sidecar, 'utf8'))).toEqual({
        hwaccel: 'gpu',
      });
    });

    it('rejects an invalid mode', () => {
      const { svc } = build(gpuFake({}));
      expect(() => svc.setMode('live', 'turbo' as never)).toThrow();
    });

    it('falls back to the default on a corrupt sidecar', () => {
      const { svc, dataDir } = build(gpuFake({}));
      const dir = path.join(dataDir, 'apps', 'live');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'transcoding.json'), 'not json');
      expect(svc.getMode('live')).toBe('auto');
    });
  });

  // --- decision matrix ------------------------------------------------------
  describe('resolve', () => {
    it('cpu mode ⇒ cpu regardless of GPU', async () => {
      const { svc } = build(gpuFake({ available: true, type: 'nvidia' }));
      svc.setMode('live', 'cpu');
      const d = await svc.resolve('live');
      expect(d).toMatchObject({ requested: 'cpu', effective: 'cpu', type: 'none' });
    });

    it('gpu mode + GPU available ⇒ gpu', async () => {
      const { svc } = build(gpuFake({ available: true, type: 'nvidia' }));
      svc.setMode('live', 'gpu');
      const d = await svc.resolve('live');
      expect(d).toMatchObject({ effective: 'gpu', type: 'nvidia' });
    });

    it('gpu mode + no GPU ⇒ cpu fallback', async () => {
      const { svc } = build(gpuFake({ available: false, type: 'none' }));
      svc.setMode('live', 'gpu');
      const d = await svc.resolve('live');
      expect(d.effective).toBe('cpu');
      expect(d.reason).toMatch(/fallback/i);
    });

    it('auto + GPU available ⇒ gpu (vaapi)', async () => {
      const { svc } = build(gpuFake({ available: true, type: 'vaapi' }));
      const d = await svc.resolve('live'); // default auto
      expect(d).toMatchObject({ requested: 'auto', effective: 'gpu', type: 'vaapi' });
    });

    it('auto + no GPU ⇒ cpu', async () => {
      const { svc } = build(gpuFake({ available: false }));
      const d = await svc.resolve('live');
      expect(d).toMatchObject({ requested: 'auto', effective: 'cpu' });
    });

    it('degrades to cpu (never throws) when GpuService.status rejects', async () => {
      const gpu = {
        status: jest.fn(async () => {
          throw new Error('boom');
        }),
      } as unknown as GpuService;
      const { svc } = build(gpu);
      const d = await svc.resolve('live');
      expect(d.effective).toBe('cpu');
    });
  });

  // --- SDK option builders --------------------------------------------------
  describe('egressEncoding', () => {
    it('returns H.264 EncodingOptions when GPU is chosen', async () => {
      const { svc } = build(gpuFake({ available: true, type: 'nvidia' }));
      const { encodingOptions, decision } = await svc.egressEncoding('live');
      expect(decision.effective).toBe('gpu');
      expect(encodingOptions).toBeDefined();
      expect(encodingOptions?.videoCodec).toBe(VideoCodec.H264_MAIN);
      expect(encodingOptions?.width).toBe(1280);
    });

    it('returns NO options on CPU (preserves default behaviour)', async () => {
      const { svc } = build(gpuFake({ available: false }));
      const { encodingOptions, decision } = await svc.egressEncoding('live');
      expect(decision.effective).toBe('cpu');
      expect(encodingOptions).toBeUndefined();
    });
  });

  describe('ingressVideo', () => {
    it('returns IngressVideoOptions when GPU is chosen', async () => {
      const { svc } = build(gpuFake({ available: true, type: 'nvidia' }));
      const { video, decision } = await svc.ingressVideo('live');
      expect(decision.effective).toBe('gpu');
      expect(video).toBeDefined();
      expect(video?.encodingOptions.case).toBe('preset');
    });

    it('returns NO options on CPU', async () => {
      const { svc } = build(gpuFake({ available: false }));
      const { video } = await svc.ingressVideo('live');
      expect(video).toBeUndefined();
    });
  });

  // --- metrics --------------------------------------------------------------
  describe('recordUsage', () => {
    it('forwards the accel path to the metrics counter', () => {
      const { svc, metrics } = build(gpuFake({}));
      svc.recordUsage('egress', {
        requested: 'auto',
        effective: 'gpu',
        type: 'nvidia',
        reason: 'x',
      });
      expect(metrics.recordTranscode).toHaveBeenCalledWith(
        'egress',
        'gpu',
        'nvidia',
      );
    });
  });
});
