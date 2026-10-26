/**
 * Unit spec — CallbacksService.onDispatch trigger hook (Streamflow engine).
 *
 * Locks down the additive in-process listener registry tapped by
 * StreamflowService: a listener sees every dispatched event, fires even when the
 * app has NO callback URL, a throwing listener never breaks dispatch (nor the
 * webhook), and unsubscribe works.
 */
import { CallbacksService } from './callbacks.service';
import type { CallbackEvent } from '../../shared/contracts';
import { mockAppsService, mockLogsService } from '../../../test/helpers';

describe('CallbacksService.onDispatch (trigger hook)', () => {
  let apps: ReturnType<typeof mockAppsService>;
  let logs: ReturnType<typeof mockLogsService>;
  let svc: CallbacksService;
  let realFetch: typeof global.fetch;

  beforeEach(() => {
    apps = mockAppsService();
    logs = mockLogsService();
    svc = new CallbacksService(apps as never, logs as never);
    svc.hostResolver = async () => ['93.184.216.34'];
    realFetch = global.fetch;
    global.fetch = jest.fn(async () => ({ ok: true, status: 200 }) as never);
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  it('invokes a registered listener with (app, event, payload)', async () => {
    apps.getConfig.mockResolvedValue({
      callbacks: { url: 'https://hook.test/cb' },
    } as never);
    const seen: Array<[string, string, Record<string, unknown>]> = [];
    svc.onDispatch((app, event, payload) => seen.push([app, event, payload]));

    await svc.dispatch('live', 'plate.detected' as CallbackEvent, { plate: 'ABC' });

    expect(seen).toHaveLength(1);
    expect(seen[0][0]).toBe('live');
    expect(seen[0][1]).toBe('plate.detected');
    expect(seen[0][2]).toMatchObject({ plate: 'ABC' });
  });

  it('fires even when the app has NO callback URL configured', async () => {
    apps.getConfig.mockResolvedValue({ callbacks: {} } as never);
    const seen: string[] = [];
    svc.onDispatch((_a, event) => seen.push(event));

    await svc.dispatch('live', 'stream_started' as CallbackEvent, {});

    // No webhook went out (no URL) but the trigger tap still saw the event.
    expect(global.fetch).not.toHaveBeenCalled();
    expect(seen).toEqual(['stream_started']);
  });

  it('a throwing listener never breaks dispatch nor the webhook', async () => {
    apps.getConfig.mockResolvedValue({
      callbacks: { url: 'https://hook.test/cb' },
    } as never);
    const good = jest.fn();
    svc.onDispatch(() => {
      throw new Error('boom');
    });
    svc.onDispatch(good);

    await expect(
      svc.dispatch('live', 'vod_ready' as CallbackEvent, { id: 1 }),
    ).resolves.toBeUndefined();

    // The webhook still fired and the second listener still ran.
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(1);
  });

  it('unsubscribe stops further invocations', async () => {
    apps.getConfig.mockResolvedValue({ callbacks: {} } as never);
    const fn = jest.fn();
    const off = svc.onDispatch(fn);

    await svc.dispatch('live', 'reaction' as CallbackEvent, {});
    off();
    await svc.dispatch('live', 'reaction' as CallbackEvent, {});

    expect(fn).toHaveBeenCalledTimes(1);
  });
});
