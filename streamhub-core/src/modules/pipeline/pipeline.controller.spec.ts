/**
 * Unit spec — PipelineController (feature pipeline).
 *
 * Thin-controller checks: the handler wraps PipelineService.get in the
 * standard `{ data, error: null }` envelope, passes the :app param through
 * verbatim, and propagates the service's 404 untouched.
 */
import { NotFoundException } from '@nestjs/common';

import { PipelineController } from './pipeline.controller';
import type { AppPipeline, PipelineService } from './pipeline.service';

const emptyPipeline: AppPipeline = {
  ingest: [],
  ingestFront: { mediamtx: false, port: 1935 },
  processing: {
    transcoding: { enabled: false, encoder: 'cpu', hwaccel: 'auto' },
    adaptive: { enabled: false, layers: [] },
    passthrough: { enabled: false, transports: [] },
  },
  compute: {
    edge: { total: 0, online: 0 },
    vision: { enabled: false, models: [], assignments: { running: 0, pending: 0 } },
  },
  delivery: [],
  storage: { recording: { enabled: false }, s3: { configured: false } },
  plugins: [],
  live: { activeStreams: 0, tags: [] },
  events: {
    callbacks: { configured: false },
    mqtt: { enabled: false },
    log: { enabled: true },
  },
  notifications: { email: false, discord: false, telegram: false },
  net: { inBytes: 0, outBytes: 0, windowSec: 3600 },
};

describe('PipelineController', () => {
  it('wraps the topology in the { data, error: null } envelope', async () => {
    const get = jest.fn(async () => emptyPipeline);
    const controller = new PipelineController({
      get,
    } as unknown as PipelineService);

    await expect(controller.get('live')).resolves.toEqual({
      data: emptyPipeline,
      error: null,
    });
    expect(get).toHaveBeenCalledWith('live');
  });

  it('propagates the 404 of an unknown app', async () => {
    const controller = new PipelineController({
      get: jest.fn(async () => {
        throw new NotFoundException('app "nope" not found');
      }),
    } as unknown as PipelineService);

    await expect(controller.get('nope')).rejects.toThrow(NotFoundException);
  });
});
