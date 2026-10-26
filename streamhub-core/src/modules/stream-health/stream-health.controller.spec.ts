/**
 * Unit spec — StreamHealthController. Service is a stub (no Nest DI). Locks
 * the SPEC §6 envelope on every route, the events limit clamp + room scope
 * passthrough, the settings body unwrap ({ config }), and the
 * HealthSettingsError → 400 mapping (any other error re-thrown untouched).
 */
import { BadRequestException } from '@nestjs/common';

import { StreamHealthController } from './stream-health.controller';
import type { StreamHealthService } from './stream-health.service';
import { HealthSettingsError } from './stream-health.thresholds';

describe('StreamHealthController', () => {
  const calls: Record<string, unknown[]> = {};
  const svc = {
    overview: (...a: unknown[]) => {
      calls.overview = a;
      return Promise.resolve({ today: 3, rooms: [] });
    },
    events: (...a: unknown[]) => {
      calls.events = a;
      return Promise.resolve([{ id: 1 }]);
    },
    getSettings: (...a: unknown[]) => {
      calls.getSettings = a;
      return Promise.resolve({ room: 'cam-1' });
    },
    putSettings: (...a: unknown[]) => {
      calls.putSettings = a;
      return Promise.resolve({ room: 'cam-1' });
    },
  };
  const controller = new StreamHealthController(
    svc as unknown as StreamHealthService,
  );

  it('wraps overview in the envelope', async () => {
    expect(await controller.overview('live')).toEqual({
      data: { today: 3, rooms: [] },
      error: null,
    });
    expect(calls.overview).toEqual(['live']);
  });

  it('clamps the events limit and forwards the optional room scope', async () => {
    await controller.events('live', '5000', ' cam-1 ');
    expect(calls.events).toEqual(['live', 1000, 'cam-1']);

    await controller.events('live', 'garbage', undefined);
    expect(calls.events).toEqual(['live', 50, undefined]);

    await controller.events('live', undefined, '');
    expect(calls.events).toEqual(['live', 50, undefined]);
  });

  it('reads settings through the envelope', async () => {
    expect(await controller.getSettings('live', 'cam-1')).toEqual({
      data: { room: 'cam-1' },
      error: null,
    });
    expect(calls.getSettings).toEqual(['live', 'cam-1']);
  });

  it('unwraps { config } on PUT and defaults a missing body to {}', async () => {
    await controller.putSettings('live', 'cam-1', { config: { stall_sec: 30 } });
    expect(calls.putSettings).toEqual(['live', 'cam-1', { stall_sec: 30 }]);

    await controller.putSettings('live', 'cam-1', {} as never);
    expect(calls.putSettings).toEqual(['live', 'cam-1', {}]);
  });

  it('maps HealthSettingsError to a 400 and re-throws anything else', async () => {
    svc.putSettings = () => Promise.reject(new HealthSettingsError('bad key'));
    await expect(
      controller.putSettings('live', 'cam-1', { config: { nope: 1 } }),
    ).rejects.toBeInstanceOf(BadRequestException);

    const boom = new Error('db locked');
    svc.putSettings = () => Promise.reject(boom);
    await expect(
      controller.putSettings('live', 'cam-1', { config: {} }),
    ).rejects.toBe(boom);
  });
});
