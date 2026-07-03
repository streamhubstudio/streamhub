/**
 * Unit specs for RestreamService + RestreamController wiring (module restream).
 *
 * Multi-destination RTMP forwarding (AntMedia "endpoints") over a REAL
 * migrated per-app DB, with LiveKit/Streams/Callbacks mocked (nothing dials
 * the network). Locks down:
 *  - start/list/stop of destinations (one LiveKit stream egress per target);
 *  - N simultaneous destinations, each with its own egress;
 *  - one endpoint failing (EGRESS_FAILED) marks ONLY that endpoint failed and
 *    fires restream_failed — the other destinations are untouched;
 *  - bounded retry with backoff relaunches a failed endpoint (best-effort);
 *  - the destination stream key is NEVER exposed: API views and callback
 *    payloads only carry the masked URL;
 *  - duplicate destination → 409; unknown stream → 404;
 *  - RBAC wiring: the controller declares broadcast:start/read/stop;
 *  - tenant/app isolation: rows live in the app's OWN app.db, invisible to
 *    another app.
 */
import { Reflector } from '@nestjs/core';
import { ConflictException, NotFoundException } from '@nestjs/common';

import { makeUnitContext, type UnitContext } from '../../../test/helpers';
import { REQUIRE_PERMISSION_KEY } from '../authz/permission.decorator';
import { RestreamController } from './restream.controller';
import { RestreamRepository } from './restream.repository';
import { RestreamService } from './restream.service';
import type { StreamRecord } from '../../shared/contracts';

const KEY = 'abcd-efgh-ijkl-mnop';
const ROOM = 'live-room1';

function streamRecord(room = ROOM): StreamRecord {
  return {
    id: 1,
    appId: 1,
    streamId: `${room}/pub1`,
    type: 'webrtc',
    room,
    participant: 'pub1',
    status: 'active',
    startedAt: '2026-01-01 00:00:00',
    endedAt: null,
    lastStatsJson: null,
  };
}

describe('RestreamService', () => {
  let ctx: UnitContext;
  let repo: RestreamRepository;
  let svc: RestreamService;
  let egressSeq: number;

  beforeEach(() => {
    ctx = makeUnitContext();
    repo = new RestreamRepository(ctx.db);
    svc = new RestreamService(
      repo,
      ctx.mocks.livekit,
      ctx.mocks.streams,
      ctx.mocks.logs,
      ctx.mocks.callbacks,
    );
    ctx.mocks.streams.get.mockResolvedValue(streamRecord());
    egressSeq = 0;
    ctx.mocks.livekit.startStreamEgress.mockImplementation(async (input) => ({
      egressId: `EG_${++egressSeq}`,
      status: 'EGRESS_STARTING',
      roomName: input.roomName,
      urls: [input.rtmpUrl],
    }));
  });

  afterEach(() => {
    svc.onModuleDestroy();
    ctx.cleanup();
  });

  // ---------------------------------------------------------------------------
  // add
  // ---------------------------------------------------------------------------

  it('starts a stream egress towards the preset URL (YouTube base + key)', async () => {
    const view = await svc.add('live', `${ROOM}/pub1`, {
      platform: 'youtube',
      key: KEY,
      name: 'Mi canal',
    });

    expect(ctx.mocks.livekit.startStreamEgress).toHaveBeenCalledWith({
      appName: 'live',
      roomName: ROOM,
      rtmpUrl: `rtmp://a.rtmp.youtube.com/live2/${KEY}`,
      layout: undefined,
    });
    expect(view.egressId).toBe('EG_1');
    expect(view.status).toBe('starting');
    expect(view.platform).toBe('youtube');
    expect(view.name).toBe('Mi canal');
  });

  it('supports N simultaneous destinations — one egress per target', async () => {
    await svc.add('live', `${ROOM}/pub1`, { platform: 'youtube', key: KEY });
    await svc.add('live', `${ROOM}/pub1`, { platform: 'twitch', key: 'tw_key_1' });
    await svc.add('live', `${ROOM}/pub1`, {
      platform: 'custom',
      url: 'rtmp://ingest.example.com/live/k123456',
    });

    expect(ctx.mocks.livekit.startStreamEgress).toHaveBeenCalledTimes(3);
    const list = await svc.list('live', `${ROOM}/pub1`);
    expect(list).toHaveLength(3);
    expect(new Set(list.map((t) => t.egressId)).size).toBe(3);
  });

  it('fires the restream_started callback (HMAC dispatcher) with a MASKED url', async () => {
    await svc.add('live', `${ROOM}/pub1`, { platform: 'youtube', key: KEY });

    expect(ctx.mocks.callbacks.dispatch).toHaveBeenCalledWith(
      'live',
      'restream_started',
      expect.objectContaining({ room: ROOM, egressId: 'EG_1' }),
    );
    const payload = ctx.mocks.callbacks.dispatch.mock.calls[0][2];
    expect(JSON.stringify(payload)).not.toContain(KEY);
  });

  it('rejects a duplicate live destination with 409', async () => {
    await svc.add('live', `${ROOM}/pub1`, { platform: 'youtube', key: KEY });
    await expect(
      svc.add('live', `${ROOM}/pub1`, { platform: 'youtube', key: KEY }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(ctx.mocks.livekit.startStreamEgress).toHaveBeenCalledTimes(1);
  });

  it('404s when the stream does not exist', async () => {
    ctx.mocks.streams.get.mockResolvedValue(null);
    await expect(
      svc.add('live', 'nope', { platform: 'youtube', key: KEY }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  // ---------------------------------------------------------------------------
  // key masking — the destination stream key NEVER leaves the server
  // ---------------------------------------------------------------------------

  it('never returns the destination key: views only carry the masked URL', async () => {
    const view = await svc.add('live', `${ROOM}/pub1`, {
      platform: 'youtube',
      key: KEY,
    });
    expect(view.urlMasked).toBe('rtmp://a.rtmp.youtube.com/live2/abcd…');
    expect(JSON.stringify(view)).not.toContain(KEY);

    const list = await svc.list('live', `${ROOM}/pub1`);
    expect(JSON.stringify(list)).not.toContain(KEY);

    // The FULL url stays server-side (needed for retry) but is not in the view.
    const row = repo.byEgressId('live', view.egressId as string);
    expect(row?.url).toContain(KEY);
    expect(Object.keys(view)).not.toContain('url');
  });

  // ---------------------------------------------------------------------------
  // list + status refresh
  // ---------------------------------------------------------------------------

  it('upgrades starting → active from the live egress listing', async () => {
    await svc.add('live', `${ROOM}/pub1`, { platform: 'youtube', key: KEY });
    ctx.mocks.livekit.listStreamEgress.mockResolvedValue([
      { egressId: 'EG_1', status: 'EGRESS_ACTIVE', roomName: ROOM, urls: [] },
    ]);

    const list = await svc.list('live', `${ROOM}/pub1`);
    expect(list[0].status).toBe('active');
  });

  // ---------------------------------------------------------------------------
  // remove (stop ONE destination)
  // ---------------------------------------------------------------------------

  it('stops one destination: stopEgress + row stopped + restream_stopped', async () => {
    const a = await svc.add('live', `${ROOM}/pub1`, { platform: 'youtube', key: KEY });
    await svc.add('live', `${ROOM}/pub1`, { platform: 'twitch', key: 'tw_key_1' });

    const view = await svc.remove('live', `${ROOM}/pub1`, a.egressId as string);
    expect(view.status).toBe('stopped');
    expect(ctx.mocks.livekit.stopEgress).toHaveBeenCalledWith('EG_1');
    expect(ctx.mocks.callbacks.dispatch).toHaveBeenCalledWith(
      'live',
      'restream_stopped',
      expect.objectContaining({ egressId: 'EG_1', reason: 'stopped_by_user' }),
    );

    // The OTHER destination keeps running and is still listed.
    const list = await svc.list('live', `${ROOM}/pub1`);
    expect(list).toHaveLength(1);
    expect(list[0].egressId).toBe('EG_2');
  });

  it('404s when stopping an egress that belongs to no destination', async () => {
    await expect(
      svc.remove('live', `${ROOM}/pub1`, 'EG_nope'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('does not double-fire restream_stopped when the webhook lands after a manual stop', async () => {
    const a = await svc.add('live', `${ROOM}/pub1`, { platform: 'youtube', key: KEY });
    await svc.remove('live', `${ROOM}/pub1`, a.egressId as string);
    ctx.mocks.callbacks.dispatch.mockClear();

    await svc.onEgressEvent('live', a.egressId as string, 'EGRESS_COMPLETE');
    expect(ctx.mocks.callbacks.dispatch).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // webhook state machine — failures are per-endpoint
  // ---------------------------------------------------------------------------

  it('EGRESS_ACTIVE marks the endpoint active', async () => {
    await svc.add('live', `${ROOM}/pub1`, { platform: 'youtube', key: KEY });
    await svc.onEgressEvent('live', 'EG_1', 'EGRESS_ACTIVE');
    const list = await svc.list('live', `${ROOM}/pub1`);
    expect(list[0].status).toBe('active');
  });

  it('a failed endpoint NEVER takes down the others', async () => {
    await svc.add('live', `${ROOM}/pub1`, { platform: 'youtube', key: KEY });
    await svc.add('live', `${ROOM}/pub1`, { platform: 'twitch', key: 'tw_key_1' });
    await svc.onEgressEvent('live', 'EG_1', 'EGRESS_ACTIVE');
    await svc.onEgressEvent('live', 'EG_2', 'EGRESS_ACTIVE');

    await svc.onEgressEvent('live', 'EG_1', 'EGRESS_FAILED');

    const list = await svc.list('live', `${ROOM}/pub1`);
    const byEgress = new Map(list.map((t) => [t.egressId, t.status]));
    expect(byEgress.get('EG_1')).toBe('failed');
    expect(byEgress.get('EG_2')).toBe('active'); // untouched
    expect(ctx.mocks.livekit.stopEgress).not.toHaveBeenCalled();
    expect(ctx.mocks.callbacks.dispatch).toHaveBeenCalledWith(
      'live',
      'restream_failed',
      expect.objectContaining({ egressId: 'EG_1' }),
    );
    const failedPayload = ctx.mocks.callbacks.dispatch.mock.calls
      .filter((c) => c[1] === 'restream_failed')
      .map((c) => c[2])[0];
    expect(JSON.stringify(failedPayload)).not.toContain(KEY);
  });

  it('EGRESS_COMPLETE marks the endpoint stopped + fires restream_stopped', async () => {
    await svc.add('live', `${ROOM}/pub1`, { platform: 'youtube', key: KEY });
    await svc.onEgressEvent('live', 'EG_1', 'EGRESS_COMPLETE');
    expect(ctx.mocks.callbacks.dispatch).toHaveBeenCalledWith(
      'live',
      'restream_stopped',
      expect.objectContaining({ egressId: 'EG_1', reason: 'completed' }),
    );
    expect((await svc.list('live', `${ROOM}/pub1`))).toHaveLength(0);
  });

  it('ignores egress events that match no destination (recording/HLS egresses)', async () => {
    await expect(
      svc.onEgressEvent('live', 'EG_recording', 'EGRESS_FAILED'),
    ).resolves.toBeUndefined();
    expect(ctx.mocks.callbacks.dispatch).not.toHaveBeenCalled();
  });

  it('resolves the app from its in-memory map when the webhook has no app', async () => {
    await svc.add('live', `${ROOM}/pub1`, { platform: 'youtube', key: KEY });
    await svc.onEgressEvent(null, 'EG_1', 'EGRESS_ACTIVE');
    const list = await svc.list('live', `${ROOM}/pub1`);
    expect(list[0].status).toBe('active');
  });

  // ---------------------------------------------------------------------------
  // retry with backoff (best-effort)
  // ---------------------------------------------------------------------------

  it('relaunches a failed endpoint with backoff (new egress, retries+1)', async () => {
    jest.useFakeTimers();
    try {
      await svc.add('live', `${ROOM}/pub1`, { platform: 'youtube', key: KEY });
      await svc.onEgressEvent('live', 'EG_1', 'EGRESS_FAILED');

      expect(ctx.mocks.livekit.startStreamEgress).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(5_000);

      expect(ctx.mocks.livekit.startStreamEgress).toHaveBeenCalledTimes(2);
      expect(ctx.mocks.livekit.startStreamEgress).toHaveBeenLastCalledWith({
        appName: 'live',
        roomName: ROOM,
        rtmpUrl: `rtmp://a.rtmp.youtube.com/live2/${KEY}`,
      });
      const list = await svc.list('live', `${ROOM}/pub1`);
      expect(list[0].egressId).toBe('EG_2');
      expect(list[0].status).toBe('starting');
      expect(list[0].retries).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does NOT retry an endpoint that was stopped meanwhile', async () => {
    jest.useFakeTimers();
    try {
      const a = await svc.add('live', `${ROOM}/pub1`, {
        platform: 'youtube',
        key: KEY,
      });
      await svc.onEgressEvent('live', 'EG_1', 'EGRESS_FAILED');
      // User dismisses the failed endpoint before the backoff fires… by row id
      // it is now 'stopped', so the pending retry must be a no-op.
      const row = repo.byEgressId('live', a.egressId as string);
      repo.setStatus('live', row!.id, 'stopped');

      await jest.advanceTimersByTimeAsync(60_000);
      expect(ctx.mocks.livekit.startStreamEgress).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  // ---------------------------------------------------------------------------
  // tenant/app isolation — per-app app.db
  // ---------------------------------------------------------------------------

  it('destinations of one app are invisible to another app (per-app DB)', async () => {
    await svc.add('live', `${ROOM}/pub1`, { platform: 'youtube', key: KEY });

    // Same room name, other app → its own app.db has no rows.
    expect(repo.listByRoom('other', ROOM)).toHaveLength(0);
    const otherList = await svc.list('other', `${ROOM}/pub1`);
    expect(otherList).toHaveLength(0);

    // And an egress lookup under the other app finds nothing to stop.
    await expect(
      svc.remove('other', `${ROOM}/pub1`, 'EG_1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

// -----------------------------------------------------------------------------
// Controller wiring — RBAC permissions (AUTHZ=on enforcement is the guard's,
// covered by permission.guard.spec; here we lock the declared metadata).
// -----------------------------------------------------------------------------

describe('RestreamController — permissions', () => {
  const reflector = new Reflector();

  it("POST declares 'broadcast:start'", () => {
    expect(
      reflector.get(REQUIRE_PERMISSION_KEY, RestreamController.prototype.add),
    ).toEqual({ resource: 'broadcast', action: 'start' });
  });

  it("GET declares 'broadcast:read'", () => {
    expect(
      reflector.get(REQUIRE_PERMISSION_KEY, RestreamController.prototype.list),
    ).toEqual({ resource: 'broadcast', action: 'read' });
  });

  it("DELETE declares 'broadcast:stop'", () => {
    expect(
      reflector.get(REQUIRE_PERMISSION_KEY, RestreamController.prototype.remove),
    ).toEqual({ resource: 'broadcast', action: 'stop' });
  });

  it('POST enforces the tenant egress quota before starting', async () => {
    const restream = { add: jest.fn() } as unknown as RestreamService;
    const quotas = { enforceEgress: jest.fn().mockRejectedValue(new Error('quota')) };
    const ctrl = new RestreamController(restream, quotas as never);
    await expect(
      ctrl.add('live', 'room/pub', { platform: 'youtube', key: 'k' }),
    ).rejects.toThrow('quota');
    expect((restream as unknown as { add: jest.Mock }).add).not.toHaveBeenCalled();
  });
});
