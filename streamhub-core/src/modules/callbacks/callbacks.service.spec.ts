/**
 * Unit spec — CallbacksService (callbacks-webhooks module).
 *
 * Exercises the outbound per-app webhook dispatcher in isolation:
 *   new CallbacksService(APPS_SERVICE, LOGS_SERVICE)
 * with `global.fetch` stubbed (nothing hits the network). Covers the signed
 * dispatch envelope (X-StreamHub-Signature HMAC-SHA256), the "no URL → no fire"
 * invariant, the event taxonomy passthrough, and the never-throws / retry
 * contract of the delivery loop.
 *
 * Owned by the callbacks-webhooks test agent. Uses only the shared harness
 * mocks (test/helpers). No harness/src files are modified here.
 */
import { createHmac } from 'node:crypto';

import { CallbacksService } from './callbacks.service';
import type { CallbackEvent } from '../../shared/contracts';
import { mockAppsService, mockLogsService } from '../../../test/helpers';

type FetchResult = {
  ok: boolean;
  status: number;
};

function okResponse(status = 200): FetchResult {
  return { ok: status >= 200 && status < 300, status };
}

/** Minimal AppConfig-ish object with just the callbacks block the service reads. */
function configWith(callbacks: { url?: string; secret?: string }): any {
  return { callbacks };
}

/** Grab the [url, init] of the Nth fetch call. */
function fetchCall(n = 0): [string, any] {
  return (global.fetch as jest.Mock).mock.calls[n] as [string, any];
}

describe('CallbacksService', () => {
  let apps: ReturnType<typeof mockAppsService>;
  let logs: ReturnType<typeof mockLogsService>;
  let svc: CallbacksService;
  let realFetch: typeof global.fetch;

  beforeEach(() => {
    apps = mockAppsService();
    logs = mockLogsService();
    svc = new CallbacksService(apps as any, logs as any);
    realFetch = global.fetch;
    global.fetch = jest.fn(async () => okResponse(200) as any);
  });

  afterEach(() => {
    global.fetch = realFetch;
    jest.useRealTimers();
  });

  // ---------------------------------------------------------------------------
  // Happy path — signed dispatch
  // ---------------------------------------------------------------------------

  describe('signed dispatch (happy path)', () => {
    beforeEach(() => {
      apps.getConfig.mockResolvedValue(
        configWith({ url: 'https://hook.test/cb', secret: 's3cr3t' }),
      );
    });

    it('POSTs once to the configured callback URL', async () => {
      await svc.dispatch('live', 'stream_started', { room: 'live-1' });

      expect(global.fetch).toHaveBeenCalledTimes(1);
      const [url, init] = fetchCall();
      expect(url).toBe('https://hook.test/cb');
      expect(init.method).toBe('POST');
    });

    it('signs the exact body with HMAC-SHA256 as sha256=<hex>', async () => {
      await svc.dispatch('live', 'stream_started', { room: 'live-1' });

      const [, init] = fetchCall();
      const sig = init.headers['x-streamhub-signature'];
      expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);

      // Signature MUST verify against the exact bytes we sent.
      const expected =
        'sha256=' +
        createHmac('sha256', 's3cr3t').update(init.body).digest('hex');
      expect(sig).toBe(expected);
    });

    it('emits the wave-3 envelope { id,event,app,room,ts,timestamp,data }', async () => {
      await svc.dispatch('live', 'stream_started', {
        room: 'live-1',
        streamId: 'live-1/pub',
      });

      const [, init] = fetchCall();
      const body = JSON.parse(init.body);
      expect(body).toMatchObject({
        event: 'stream_started',
        app: 'live',
        room: 'live-1',
        data: { room: 'live-1', streamId: 'live-1/pub' },
      });
      // id is a UUID, ts === timestamp, both ISO-8601.
      expect(body.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(body.ts).toBe(body.timestamp);
      expect(new Date(body.ts).toISOString()).toBe(body.ts);
    });

    it('sets the tracing/content headers (event, delivery, timestamp)', async () => {
      await svc.dispatch('live', 'vod_ready', { room: 'live-1' });

      const [, init] = fetchCall();
      const body = JSON.parse(init.body);
      expect(init.headers['content-type']).toBe('application/json');
      expect(init.headers['user-agent']).toBe('streamhub-core/callbacks');
      expect(init.headers['x-streamhub-event']).toBe('vod_ready');
      // Delivery header MUST equal the envelope id (traceable delivery).
      expect(init.headers['x-streamhub-delivery']).toBe(body.id);
      expect(init.headers['x-streamhub-timestamp']).toBe(body.timestamp);
    });

    it('room is null when payload.room is absent or non-string', async () => {
      await svc.dispatch('live', 'stream_started', { room: 123 as any });
      const body = JSON.parse(fetchCall()[1].body);
      expect(body.room).toBeNull();
      // data still carries the raw payload verbatim.
      expect(body.data).toEqual({ room: 123 });
    });

    it('forwards ANY event name in the taxonomy verbatim', async () => {
      const events: CallbackEvent[] = [
        'room_started',
        'room_finished',
        'participant_joined',
        'participant_left',
        'track_published',
        'track_unpublished',
        'ingress_started',
        'ingress_ended',
        'egress_started',
        'egress_updated',
        'egress_ended',
        'stream_started',
        'stream_ended',
        'recording_started',
        'recording_part_ready',
        'recording_ready',
        'recording_failed',
        'snapshot_taken',
        'vod_ready',
        'hls_started',
        'hls_stopped',
      ];
      for (const ev of events) {
        (global.fetch as jest.Mock).mockClear();
        await svc.dispatch('live', ev, { room: 'live-1' });
        const body = JSON.parse(fetchCall()[1].body);
        expect(body.event).toBe(ev);
        expect(fetchCall()[1].headers['x-streamhub-event']).toBe(ev);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // "no URL → never fires" invariant + config edges
  // ---------------------------------------------------------------------------

  describe('does not fire without a URL', () => {
    it('skips (no fetch) when callbacks.url is empty', async () => {
      apps.getConfig.mockResolvedValue(configWith({ url: '', secret: 'x' }));
      await svc.dispatch('live', 'stream_started', { room: 'live-1' });
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('skips (no fetch) when callbacks.url is only whitespace', async () => {
      apps.getConfig.mockResolvedValue(configWith({ url: '   ', secret: 'x' }));
      await svc.dispatch('live', 'stream_started', { room: 'live-1' });
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('skips (no fetch) when the callbacks block is missing', async () => {
      apps.getConfig.mockResolvedValue({} as any);
      await svc.dispatch('live', 'stream_started', { room: 'live-1' });
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('does not throw and does not fetch when getConfig throws', async () => {
      apps.getConfig.mockRejectedValue(new Error('no such app'));
      await expect(
        svc.dispatch('ghost', 'stream_started', { room: 'x' }),
      ).resolves.toBeUndefined();
      expect(global.fetch).not.toHaveBeenCalled();
      expect(logs.write).toHaveBeenCalledWith(
        'warn',
        'callbacks',
        expect.stringContaining('could not load config'),
        expect.any(Object),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Signature is optional (URL without secret)
  // ---------------------------------------------------------------------------

  describe('unsigned dispatch (URL but no secret)', () => {
    it('still POSTs but omits the signature header', async () => {
      apps.getConfig.mockResolvedValue(configWith({ url: 'https://hook.test/cb' }));
      await svc.dispatch('live', 'stream_started', { room: 'live-1' });

      expect(global.fetch).toHaveBeenCalledTimes(1);
      const [, init] = fetchCall();
      expect(init.headers['x-streamhub-signature']).toBeUndefined();
      // Non-secret tracing headers are still present.
      expect(init.headers['x-streamhub-event']).toBe('stream_started');
    });
  });

  // ---------------------------------------------------------------------------
  // Delivery loop — retries, non-retryable rejects, never throws
  // ---------------------------------------------------------------------------

  describe('delivery loop', () => {
    beforeEach(() => {
      apps.getConfig.mockResolvedValue(
        configWith({ url: 'https://hook.test/cb', secret: 's' }),
      );
    });

    it('logs "delivered" once on a 2xx and does not retry', async () => {
      await svc.dispatch('live', 'stream_started', { room: 'live-1' });
      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(logs.write).toHaveBeenCalledWith(
        'info',
        'callbacks',
        'delivered "stream_started"',
        expect.objectContaining({ status: 200, attempt: 1 }),
      );
    });

    it('does NOT retry a non-retryable 4xx (e.g. 400)', async () => {
      (global.fetch as jest.Mock).mockResolvedValue(okResponse(400) as any);
      await svc.dispatch('live', 'stream_started', { room: 'live-1' });
      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(logs.write).toHaveBeenCalledWith(
        'error',
        'callbacks',
        expect.stringContaining('HTTP 400'),
        expect.objectContaining({ retryable: false }),
      );
    });

    it('retries a 500 up to MAX_ATTEMPTS then gives up (never throws)', async () => {
      jest.useFakeTimers();
      (global.fetch as jest.Mock).mockResolvedValue(okResponse(500) as any);

      const p = svc.dispatch('live', 'stream_started', { room: 'live-1' });
      // Advance past the 500ms + 1000ms backoffs (fake timers flush microtasks).
      await jest.advanceTimersByTimeAsync(2000);
      await expect(p).resolves.toBeUndefined();

      expect(global.fetch).toHaveBeenCalledTimes(3);
      expect(logs.write).toHaveBeenCalledWith(
        'error',
        'callbacks',
        expect.stringContaining('gave up delivering'),
        expect.any(Object),
      );
    });

    it('retries a retryable 429 (rate limit)', async () => {
      jest.useFakeTimers();
      (global.fetch as jest.Mock)
        .mockResolvedValueOnce(okResponse(429) as any)
        .mockResolvedValueOnce(okResponse(200) as any);

      const p = svc.dispatch('live', 'stream_started', { room: 'live-1' });
      await jest.advanceTimersByTimeAsync(1000);
      await p;

      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect(logs.write).toHaveBeenCalledWith(
        'info',
        'callbacks',
        'delivered "stream_started"',
        expect.objectContaining({ attempt: 2 }),
      );
    });

    it('retries on a thrown network error and never rejects', async () => {
      jest.useFakeTimers();
      (global.fetch as jest.Mock).mockRejectedValue(new Error('ECONNREFUSED'));

      const p = svc.dispatch('live', 'stream_started', { room: 'live-1' });
      await jest.advanceTimersByTimeAsync(2000);
      await expect(p).resolves.toBeUndefined();

      expect(global.fetch).toHaveBeenCalledTimes(3);
    });
  });
});
