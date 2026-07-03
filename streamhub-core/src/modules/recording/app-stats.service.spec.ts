/**
 * Unit specs for AppStatsService (recording module).
 *
 * Uses the shared harness: a real migrated temp SQLite DB (global + per-app) and
 * contract mocks. A REAL StreamsService is wired with a fake RoomServiceClient so
 * the full live path (reconcile → listParticipants → viewerCounter gating) runs
 * against mocked LiveKit. Covers the complete stats shape, feature on/off for
 * viewers, and the 5s cache.
 */
import { ParticipantInfo_Kind } from '@livekit/protocol';
import { NotFoundException } from '@nestjs/common';

import { makeUnitContext, type UnitContext } from '../../../test/helpers';
import type { AppConfig, AppRecord } from '../../shared/contracts';
import { DbSizesService } from '../../shared/db/db-sizes.service';
import { StreamsService } from '../streams/streams.service';
import { AppStatsService } from './app-stats.service';
import { VodsRepository, type VodInsert } from './vods.repository';

const APP = 'live';

interface FakeParticipant {
  identity: string;
  tracks: { sid: string }[];
  kind: ParticipantInfo_Kind;
  permission?: { hidden?: boolean };
}

function participant(
  identity: string,
  opts: { publishing?: boolean; hidden?: boolean } = {},
): FakeParticipant {
  return {
    identity,
    tracks: opts.publishing ? [{ sid: `TR_${identity}` }] : [],
    kind: ParticipantInfo_Kind.STANDARD,
    permission: { hidden: opts.hidden ?? false },
  };
}

function makeAppConfig(viewerCounter: boolean): AppConfig {
  return {
    name: APP,
    displayName: 'Live',
    roomPrefix: 'live',
    recording: {
      enabled: true,
      mode: 'room-composite',
      layout: 'grid',
      localDir: 'recordings',
      deleteLocalAfterUpload: false,
      splitMinutes: 0,
      snapshotSeconds: 0,
    },
    s3: {
      provider: 'aws',
      bucket: 'b',
      region: 'us-east-1',
      forcePathStyle: false,
      prefix: 'streamhub/live',
      accessKey: 'AK',
      secretKey: 'SK',
    },
    webrtc: { adaptive: false, layers: [] },
    rtmp: { enabled: true, transcode: false },
    callbacks: { url: '', secret: '' },
    features: {
      rtmpPassword: false,
      viewerCounter,
      chat: false,
      reactions: false,
      hiddenQc: false,
      adaptivePlayer: false,
      publicPlayback: true,
    },
  };
}

describe('AppStatsService', () => {
  let ctx: UnitContext;
  let streams: StreamsService;
  let sizes: DbSizesService;
  let repo: VodsRepository;
  let svc: AppStatsService;
  let appId: number;
  let listParticipants: jest.Mock;

  const ROOM = 'live-room-1';

  function seedApp(): number {
    const res = ctx.db
      .global()
      .prepare('INSERT INTO apps (name, display_name, livekit_room_prefix) VALUES (?, ?, ?)')
      .run(APP, 'Live', 'live');
    return Number(res.lastInsertRowid);
  }

  function insertActiveStream(streamId: string, type: string, room: string, part: string): void {
    ctx.db
      .appDb(APP)
      .prepare(
        `INSERT INTO streams (app_id, stream_id, type, room, participant, status, started_at)
         VALUES (?, ?, ?, ?, ?, 'active', datetime('now'))`,
      )
      .run(appId, streamId, type, room, part);
  }

  function seedReadyVod(sizeBytes: number, status: VodInsert['status'] = 'ready'): void {
    const id = repo.insert(APP, {
      appId,
      streamId: 's',
      room: ROOM,
      name: 'rec.mp4',
      status: 'recording',
      localPath: null,
      startedAt: new Date().toISOString(),
      metatagsJson: '{}',
    });
    repo.update(APP, id, { status, sizeBytes });
  }

  function seedLog(level: string, ageMs = 0): void {
    const ts = new Date(Date.now() - ageMs).toISOString();
    ctx.db
      .global()
      .prepare(
        'INSERT INTO server_logs (ts, level, source, app_id, message) VALUES (?, ?, ?, ?, ?)',
      )
      .run(ts, level, 'recording', appId, `${level} msg`);
  }

  function buildSvc(viewerCounter: boolean): void {
    ctx.mocks.apps.getConfig.mockResolvedValue(makeAppConfig(viewerCounter));
    ctx.mocks.apps.get.mockResolvedValue({
      id: appId,
      name: APP,
      displayName: 'Live',
      livekitRoomPrefix: 'live',
      createdAt: '',
      updatedAt: '',
      settingsJson: null,
    } as AppRecord);

    streams = ctx.newService(
      StreamsService,
      ctx.config,
      ctx.db,
      ctx.mocks.apps,
      ctx.mocks.s3,
    );
    listParticipants = jest.fn(async () => [
      participant('pub1', { publishing: true }),
      participant('v1'),
      participant('v2'),
      participant('hidden1', { hidden: true }),
    ]);
    (streams as unknown as { roomClient: unknown }).roomClient = {
      listRooms: jest.fn(async () => [{ name: ROOM }]),
      listParticipants,
      removeParticipant: jest.fn(async () => undefined),
      deleteRoom: jest.fn(async () => undefined),
    };

    sizes = new DbSizesService(ctx.db);
    repo = new VodsRepository(ctx.db);
    svc = new AppStatsService(ctx.db, sizes, repo, streams, ctx.mocks.apps);
  }

  beforeEach(() => {
    ctx = makeUnitContext();
    appId = seedApp();
  });

  afterEach(() => ctx.cleanup());

  it('returns the full stats shape with viewers when the feature is ON', async () => {
    buildSvc(true);
    insertActiveStream(`${ROOM}/pub1`, 'rtmp', ROOM, 'pub1');
    seedReadyVod(1000);
    seedReadyVod(2000);
    seedReadyVod(0, 'failed');
    seedLog('error');
    seedLog('warn');
    seedLog('info');
    seedLog('info');
    seedLog('error', 3 * 24 * 3600 * 1000); // older than 24h → excluded

    const s = await svc.stats(APP);

    expect(s.app).toEqual({ name: APP, displayName: 'Live' });
    expect(typeof s.ts).toBe('string');

    // live block — viewers exposed (feature on)
    expect(s.live.activeStreams).toBe(1);
    expect(s.live.totalViewers).toBe(2);
    expect(s.live.rooms).toHaveLength(1);
    expect(s.live.rooms[0]).toMatchObject({
      room: ROOM,
      publishers: 1,
      viewers: 2,
    });
    expect(s.live.rooms[0].startedAt).toBeTruthy();

    // vods block
    expect(s.vods.count).toBe(3);
    expect(s.vods.totalBytes).toBe(3000);
    expect(s.vods.byStatus).toEqual({
      ready: 2,
      failed: 1,
      recording: 0,
      uploading: 0,
    });

    // storage block
    expect(s.storage.appDbBytes).toBeGreaterThan(0);
    expect(s.storage.vodBytes).toBe(3000);

    // ingress derived from the rtmp stream row
    expect(s.ingress).toEqual({ total: 1, active: 1 });

    // events24h — the >24h error is excluded
    expect(s.events24h).toEqual({ error: 1, warn: 1, info: 2 });
  });

  it('nulls viewers/totalViewers when the viewerCounter feature is OFF', async () => {
    buildSvc(false);
    insertActiveStream(`${ROOM}/pub1`, 'rtmp', ROOM, 'pub1');

    const s = await svc.stats(APP);
    expect(s.live.activeStreams).toBe(1);
    expect(s.live.totalViewers).toBeNull();
    expect(s.live.rooms[0]).toMatchObject({
      room: ROOM,
      publishers: 1,
      viewers: null,
    });
  });

  it('caches for 5s (a second call does not re-hit LiveKit)', async () => {
    buildSvc(true);
    insertActiveStream(`${ROOM}/pub1`, 'rtmp', ROOM, 'pub1');

    const first = await svc.stats(APP);
    const callsAfterFirst = listParticipants.mock.calls.length;
    const second = await svc.stats(APP);
    expect(listParticipants.mock.calls.length).toBe(callsAfterFirst);
    expect(second).toBe(first); // same cached object
  });

  it('throws NotFound for an unknown app', async () => {
    buildSvc(true);
    ctx.mocks.apps.get.mockResolvedValue(null);
    await expect(svc.stats('ghost')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('reports zero live/vods for an app with no activity', async () => {
    buildSvc(true);
    // No rooms live → reconcile discovers nothing.
    (streams as unknown as { roomClient: { listRooms: jest.Mock } }).roomClient.listRooms =
      jest.fn(async () => []);
    const s = await svc.stats(APP);
    expect(s.live.activeStreams).toBe(0);
    expect(s.live.rooms).toEqual([]);
    expect(s.live.totalViewers).toBe(0);
    expect(s.vods.count).toBe(0);
    expect(s.vods.totalBytes).toBe(0);
    expect(s.ingress).toEqual({ total: 0, active: 0 });
    expect(s.events24h).toEqual({ error: 0, warn: 0, info: 0 });
  });
});
