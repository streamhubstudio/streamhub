/**
 * Unit specs for StreamsService — streams TRACKING + reconcile/prune invariants.
 *
 * Owned by the streams-module test agent. Uses the shared harness
 * (test/helpers): a real migrated temp SQLite DB + contract mocks. The LiveKit
 * `RoomServiceClient`/`IngressClient` are NOT built at construction (test env
 * ships empty creds), so we inject fixed fakes onto the private fields — the
 * service only ever calls `listRooms` / `listParticipants` / `removeParticipant`
 * / `deleteRoom` / `listIngress` / `deleteIngress`, so a small stub is enough.
 *
 * Focus:
 *  - REGRESSION of the "duplicate streams" bug: one RTMP ingress + its
 *    participant + reconcile discovery collapse into exactly ONE row.
 *  - canonical stream_id derived identically by the webhook path and reconcile.
 *  - real prune: active rows with no live publisher are ended.
 *  - list() is deduplicated and returns only live/active streams.
 */
import { ParticipantInfo_Kind } from '@livekit/protocol';
import { NotFoundException, BadRequestException } from '@nestjs/common';

import { StreamsService } from './streams.service';
import { makeUnitContext, type UnitContext } from '../../../test/helpers';

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

const APP = 'live';

interface FakeParticipant {
  identity: string;
  tracks: { sid: string }[];
  kind: ParticipantInfo_Kind;
  permission?: { hidden?: boolean };
}

/** Build a LiveKit-participant-shaped object as the service reads it. */
function participant(
  identity: string,
  opts: {
    publishing?: boolean;
    kind?: ParticipantInfo_Kind;
    hidden?: boolean;
  } = {},
): FakeParticipant {
  return {
    identity,
    tracks: opts.publishing ? [{ sid: `TR_${identity}` }] : [],
    kind: opts.kind ?? ParticipantInfo_Kind.STANDARD,
    permission: { hidden: opts.hidden ?? false },
  };
}

interface RoomFixture {
  rooms: { name: string }[];
  /** room name -> participants, or a thrown-error marker. */
  participants: Record<string, FakeParticipant[] | { throw: true }>;
}

/** A minimal RoomServiceClient stub with only the methods the service calls. */
function fakeRoomClient(fx: RoomFixture) {
  return {
    listRooms: jest.fn(async () => fx.rooms),
    listParticipants: jest.fn(async (room: string) => {
      const p = fx.participants[room];
      if (p && !Array.isArray(p) && p.throw) {
        throw new Error(`listParticipants(${room}) boom`);
      }
      return (p as FakeParticipant[]) ?? [];
    }),
    removeParticipant: jest.fn(async () => undefined),
    deleteRoom: jest.fn(async () => undefined),
  };
}

/** A RoomServiceClient stub whose listRooms rejects (LiveKit unreachable). */
function unreachableRoomClient() {
  return {
    listRooms: jest.fn(async () => {
      throw new Error('ECONNREFUSED');
    }),
    listParticipants: jest.fn(async () => []),
    removeParticipant: jest.fn(async () => undefined),
    deleteRoom: jest.fn(async () => undefined),
  };
}

describe('StreamsService (streams tracking)', () => {
  let ctx: UnitContext;
  let svc: StreamsService;
  let appId: number;

  /** Insert an app into the global registry and return its id. */
  function seedApp(name = APP, prefix: string | null = name): number {
    const res = ctx.db
      .global()
      .prepare(
        'INSERT INTO apps (name, livekit_room_prefix) VALUES (?, ?)',
      )
      .run(name, prefix);
    return Number(res.lastInsertRowid);
  }

  /** Directly insert an active stream row, optionally aged into the past. */
  function insertActive(
    streamId: string,
    opts: {
      type?: string;
      room?: string | null;
      participant?: string | null;
      agoSeconds?: number;
    } = {},
  ): void {
    const {
      type = 'rtmp',
      room = 'live-room',
      participant: part = null,
      agoSeconds = 0,
    } = opts;
    ctx.db
      .appDb(APP)
      .prepare(
        `INSERT INTO streams
           (app_id, stream_id, type, room, participant, status, started_at)
         VALUES (?, ?, ?, ?, ?, 'active', datetime('now', ?))`,
      )
      .run(appId, streamId, type, room, part, `-${agoSeconds} seconds`);
  }

  function allRows(): { stream_id: string; type: string; status: string }[] {
    return ctx.db
      .appDb(APP)
      .prepare('SELECT stream_id, type, status FROM streams')
      .all() as { stream_id: string; type: string; status: string }[];
  }

  /** Attach a fake RoomServiceClient onto the (private) field under test. */
  function withRoomClient(client: unknown): void {
    (svc as unknown as { roomClient?: unknown }).roomClient = client;
  }

  beforeEach(() => {
    ctx = makeUnitContext();
    svc = ctx.newService(
      StreamsService,
      ctx.config,
      ctx.db,
      ctx.mocks.apps,
      ctx.mocks.s3,
    );
    appId = seedApp();
  });

  afterEach(() => ctx.cleanup());

  // -------------------------------------------------------------------------
  // canonical stream id
  // -------------------------------------------------------------------------

  describe('canonicalStreamId invariant', () => {
    it('is `${room}/${identity}` — the single key shared by webhook + reconcile', () => {
      expect(StreamsService.canonicalStreamId('live-room', 'pub')).toBe(
        'live-room/pub',
      );
    });
  });

  // -------------------------------------------------------------------------
  // upsert
  // -------------------------------------------------------------------------

  describe('upsert', () => {
    it('creates one active row for a new canonical stream', async () => {
      const rec = await svc.upsert(
        APP,
        'live-room/pub',
        'rtmp',
        'live-room',
        'pub',
      );
      expect(rec).toMatchObject({
        streamId: 'live-room/pub',
        type: 'rtmp',
        room: 'live-room',
        participant: 'pub',
        status: 'active',
      });
      expect(allRows()).toHaveLength(1);
    });

    it('is idempotent on the canonical key (ON CONFLICT → single row)', async () => {
      await svc.upsert(APP, 'live-room/pub', 'rtmp', 'live-room', 'pub');
      await svc.upsert(APP, 'live-room/pub', 'rtmp', 'live-room', 'pub');
      expect(allRows()).toHaveLength(1);
    });

    it('never DOWNGRADES an ingress type back to webrtc (webhook order-independent)', async () => {
      // ingress_started arrives first, then a later participant_joined ('webrtc').
      await svc.upsert(APP, 'live-room/pub', 'rtmp', 'live-room', 'pub');
      const rec = await svc.upsert(
        APP,
        'live-room/pub',
        'webrtc',
        'live-room',
        'pub',
      );
      expect(rec.type).toBe('rtmp');
      expect(allRows()).toEqual([
        expect.objectContaining({ type: 'rtmp', status: 'active' }),
      ]);
    });

    it('reactivates an ended row (status active, ended_at cleared)', async () => {
      await svc.upsert(APP, 'live-room/pub', 'rtmp', 'live-room', 'pub');
      await svc.stop(APP, 'live-room/pub'); // no roomClient → just marks ended
      const before = ctx.db
        .appDb(APP)
        .prepare('SELECT status, ended_at FROM streams WHERE stream_id = ?')
        .get('live-room/pub') as { status: string; ended_at: string | null };
      expect(before.status).toBe('ended');

      await svc.upsert(APP, 'live-room/pub', 'rtmp', 'live-room', 'pub');
      const after = ctx.db
        .appDb(APP)
        .prepare('SELECT status, ended_at FROM streams WHERE stream_id = ?')
        .get('live-room/pub') as { status: string; ended_at: string | null };
      expect(after.status).toBe('active');
      expect(after.ended_at).toBeNull();
      expect(allRows()).toHaveLength(1);
    });

    it('throws NotFound when the app does not exist', async () => {
      await expect(
        svc.upsert('ghost', 'r/p', 'rtmp', 'r', 'p'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // -------------------------------------------------------------------------
  // REGRESSION: duplicate streams for a single RTMP ingress
  // -------------------------------------------------------------------------

  describe('REGRESSION — one RTMP ingress must be ONE stream, not three', () => {
    const room = 'live-abc';
    const identity = 'rtmp-pub';
    const canonical = `${room}/${identity}`;

    it('collapses ingress_started + participant_joined + reconcile into a single active row', async () => {
      // 1) ingress_started webhook → canonical id, type rtmp.
      await svc.upsert(APP, canonical, 'rtmp', room, identity);
      // 2) participant_joined webhook for the SAME publisher → same canonical id.
      await svc.upsert(APP, canonical, 'webrtc', room, identity);

      // 3) reconcile discovers the live INGRESS publisher (list() triggers it).
      withRoomClient(
        fakeRoomClient({
          rooms: [{ name: room }],
          participants: {
            [room]: [
              participant(identity, {
                publishing: true,
                kind: ParticipantInfo_Kind.INGRESS,
              }),
            ],
          },
        }),
      );

      const list = await svc.list(APP);

      // The bug produced 3 rows (ingressId key + bare identity + reconcile);
      // the canonical key must yield exactly one.
      expect(allRows()).toHaveLength(1);
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({
        streamId: canonical,
        type: 'rtmp', // ingress type preserved, not downgraded by (2)
        status: 'active',
      });
    });

    it('reconcile ALONE (no webhook fired) creates the same canonical row', async () => {
      withRoomClient(
        fakeRoomClient({
          rooms: [{ name: room }],
          participants: {
            [room]: [
              participant(identity, {
                publishing: true,
                kind: ParticipantInfo_Kind.INGRESS,
              }),
            ],
          },
        }),
      );

      const list = await svc.list(APP);
      expect(list).toHaveLength(1);
      expect(list[0].streamId).toBe(canonical); // identical id to the webhook path
      expect(list[0].type).toBe('rtmp');
    });
  });

  // -------------------------------------------------------------------------
  // list() / reconcile — dedupe + live discovery
  // -------------------------------------------------------------------------

  describe('list() reconcile — discovery + dedupe', () => {
    it('returns distinct live publishers with no duplicate stream ids', async () => {
      withRoomClient(
        fakeRoomClient({
          rooms: [{ name: 'live-room' }],
          participants: {
            'live-room': [
              participant('camA', { publishing: true }),
              participant('camB', { publishing: true }),
              participant('viewer1', { publishing: false }), // subscriber, not a stream
            ],
          },
        }),
      );

      const list = await svc.list(APP);
      const ids = list.map((s) => s.streamId).sort();
      expect(ids).toEqual(['live-room/camA', 'live-room/camB']);
      expect(new Set(ids).size).toBe(ids.length); // deduplicated
    });

    it('does not create a stream for a non-publishing (viewer) participant', async () => {
      withRoomClient(
        fakeRoomClient({
          rooms: [{ name: 'live-room' }],
          participants: {
            'live-room': [participant('viewer1', { publishing: false })],
          },
        }),
      );
      const list = await svc.list(APP);
      expect(list).toHaveLength(0);
      expect(allRows()).toHaveLength(0);
    });

    it('REGRESSION (over-count): a subscriber (0 tracks) is NOT a stream, a publisher IS', async () => {
      withRoomClient(
        fakeRoomClient({
          rooms: [{ name: 'live-room' }],
          participants: {
            'live-room': [
              participant('broadcaster', { publishing: true }), // 1 track → stream
              participant('viewerA', { publishing: false }), // 0 tracks → NOT a stream
              participant('viewerB', { publishing: false }), // 0 tracks → NOT a stream
            ],
          },
        }),
      );
      const list = await svc.list(APP);
      // Exactly one stream — the publisher — regardless of how many subscribers.
      expect(list.map((s) => s.streamId)).toEqual(['live-room/broadcaster']);
      expect(allRows()).toHaveLength(1);
    });

    it('a pre-existing webhook row + reconcile discovery of the same publisher stays one row', async () => {
      await svc.upsert(APP, 'live-room/camA', 'webrtc', 'live-room', 'camA');
      withRoomClient(
        fakeRoomClient({
          rooms: [{ name: 'live-room' }],
          participants: {
            'live-room': [participant('camA', { publishing: true })],
          },
        }),
      );
      const list = await svc.list(APP);
      expect(list).toHaveLength(1);
      expect(allRows()).toHaveLength(1);
    });

    it('only returns active rows (ended ones are excluded)', async () => {
      insertActive('live-room/old', {
        type: 'webrtc',
        room: 'live-room',
        participant: 'old',
        agoSeconds: 60,
      });
      ctx.db
        .appDb(APP)
        .prepare("UPDATE streams SET status='ended' WHERE stream_id='live-room/old'")
        .run();
      withRoomClient(
        fakeRoomClient({ rooms: [{ name: 'live-room' }], participants: { 'live-room': [] } }),
      );
      const list = await svc.list(APP);
      expect(list).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // prune — the real fix for streams stuck "EN VIVO"
  // -------------------------------------------------------------------------

  describe('reconcile prune', () => {
    it('ends an aged active row whose participant is no longer publishing', async () => {
      insertActive('live-room/gone', {
        type: 'webrtc',
        room: 'live-room',
        participant: 'gone',
        agoSeconds: 60, // past the grace window
      });
      withRoomClient(
        fakeRoomClient({
          rooms: [{ name: 'live-room' }],
          participants: {
            // room still up, but 'gone' is not among the publishers
            'live-room': [participant('other', { publishing: true })],
          },
        }),
      );

      const list = await svc.list(APP);
      const gone = allRows().find((r) => r.stream_id === 'live-room/gone');
      expect(gone?.status).toBe('ended');
      expect(list.find((s) => s.streamId === 'live-room/gone')).toBeUndefined();
    });

    it('ends an aged active row when its room is gone entirely', async () => {
      insertActive('live-room/pub', {
        room: 'live-room',
        participant: 'pub',
        agoSeconds: 60,
      });
      withRoomClient(fakeRoomClient({ rooms: [], participants: {} }));

      await svc.list(APP);
      const row = allRows().find((r) => r.stream_id === 'live-room/pub');
      expect(row?.status).toBe('ended');
    });

    it('does NOT prune within the grace window (freshly joined, not yet publishing)', async () => {
      insertActive('live-room/fresh', {
        room: 'live-room',
        participant: 'fresh',
        agoSeconds: 0, // just created
      });
      withRoomClient(
        fakeRoomClient({
          rooms: [{ name: 'live-room' }],
          participants: { 'live-room': [] }, // not publishing yet
        }),
      );

      const list = await svc.list(APP);
      expect(list.find((s) => s.streamId === 'live-room/fresh')).toBeDefined();
    });

    it('does NOT prune a room whose participant list could not be fetched (state unknown)', async () => {
      insertActive('live-room/unknown', {
        room: 'live-room',
        participant: 'unknown',
        agoSeconds: 60,
      });
      withRoomClient(
        fakeRoomClient({
          rooms: [{ name: 'live-room' }],
          participants: { 'live-room': { throw: true } },
        }),
      );

      const list = await svc.list(APP);
      expect(list.find((s) => s.streamId === 'live-room/unknown')).toBeDefined();
    });

    it('is a no-op (prunes nothing) when LiveKit is unreachable', async () => {
      insertActive('live-room/pub', {
        room: 'live-room',
        participant: 'pub',
        agoSeconds: 60,
      });
      withRoomClient(unreachableRoomClient());

      const list = await svc.list(APP);
      expect(list.find((s) => s.streamId === 'live-room/pub')).toBeDefined();
      const row = allRows().find((r) => r.stream_id === 'live-room/pub');
      expect(row?.status).toBe('active');
    });

    it('NEVER prunes ws-mjpeg streams (gateway-owned liveness, not LiveKit)', async () => {
      // A live ESP32 camera: registered by the ws-ingest gateway, has NO
      // LiveKit room/participant behind it. reconcile must leave it alone even
      // when aged and absent from LiveKit — pruning it was flagged CRITICAL in
      // ESP32-WS-INGEST.md §2 (it would end every camera on each list()).
      insertActive('live-cam1/wscam-abc', {
        type: 'ws-mjpeg',
        room: 'live-cam1',
        participant: 'wscam-abc',
        agoSeconds: 3600, // long past the grace window
      });
      // A normal aged rtmp row in the same run IS pruned (room gone).
      insertActive('live-room/obs', {
        type: 'rtmp',
        room: 'live-room',
        participant: 'obs',
        agoSeconds: 3600,
      });
      withRoomClient(fakeRoomClient({ rooms: [], participants: {} }));

      const list = await svc.list(APP);
      expect(list.find((s) => s.streamId === 'live-cam1/wscam-abc')).toBeDefined();
      const cam = allRows().find((r) => r.stream_id === 'live-cam1/wscam-abc');
      expect(cam?.status).toBe('active');
      const rtmp = allRows().find((r) => r.stream_id === 'live-room/obs');
      expect(rtmp?.status).toBe('ended');
    });

    it('upsert never downgrades ws-mjpeg to webrtc (type is sticky)', async () => {
      await svc.upsert(APP, 'live-cam1/wscam-abc', 'ws-mjpeg', 'live-cam1', 'wscam-abc');
      await svc.upsert(APP, 'live-cam1/wscam-abc', 'webrtc', 'live-cam1', 'wscam-abc');
      const row = allRows().find((r) => r.stream_id === 'live-cam1/wscam-abc');
      expect(row?.type).toBe('ws-mjpeg');
    });

    it('ends legacy non-canonical rows (stream_id without "/") on reconcile', async () => {
      insertActive('IN_legacyIngress', {
        room: 'live-room',
        participant: null,
        agoSeconds: 60,
      });
      withRoomClient(
        fakeRoomClient({ rooms: [{ name: 'live-room' }], participants: { 'live-room': [] } }),
      );

      const list = await svc.list(APP);
      const row = allRows().find((r) => r.stream_id === 'IN_legacyIngress');
      expect(row?.status).toBe('ended');
      expect(list).toHaveLength(0);
    });

    it('when LiveKit is not configured (no roomClient), list() returns active rows untouched', async () => {
      insertActive('live-room/pub', {
        room: 'live-room',
        participant: 'pub',
        agoSeconds: 60,
      });
      // svc has no roomClient (empty creds in test env) — do not attach one.
      const list = await svc.list(APP);
      expect(list.map((s) => s.streamId)).toEqual(['live-room/pub']);
    });

    it('throws NotFound listing an unknown app', async () => {
      await expect(svc.list('ghost')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // -------------------------------------------------------------------------
  // get() — detail + viewer enrichment
  // -------------------------------------------------------------------------

  describe('get()', () => {
    it('returns null for an unknown stream id', async () => {
      expect(await svc.get(APP, 'nope')).toBeNull();
    });

    it('returns the record for an existing stream', async () => {
      await svc.upsert(APP, 'live-room/pub', 'rtmp', 'live-room', 'pub');
      const rec = await svc.get(APP, 'live-room/pub');
      expect(rec).toMatchObject({ streamId: 'live-room/pub', type: 'rtmp' });
    });

    it('exposes a viewer count (real subscribers only) when viewerCounter is enabled', async () => {
      await svc.upsert(APP, 'live-room/pub', 'webrtc', 'live-room', 'pub');
      withRoomClient(
        fakeRoomClient({
          rooms: [{ name: 'live-room' }],
          participants: {
            'live-room': [
              participant('pub', { publishing: true }), // publisher — excluded
              participant('v1', { publishing: false }), // subscriber — counted
              participant('v2', { publishing: false }), // subscriber — counted
              participant('qc', { publishing: false, hidden: true }), // hidden — excluded
            ],
          },
        }),
      );
      ctx.mocks.apps.getConfig.mockResolvedValue({
        features: { viewerCounter: true },
      } as never);

      const rec = await svc.get(APP, 'live-room/pub');
      expect(rec?.viewers).toBe(2);
    });

    it('hides the viewer count when viewerCounter is disabled', async () => {
      await svc.upsert(APP, 'live-room/pub', 'webrtc', 'live-room', 'pub');
      withRoomClient(
        fakeRoomClient({
          rooms: [{ name: 'live-room' }],
          participants: {
            'live-room': [
              participant('pub', { publishing: true }),
              participant('v1', { publishing: false }),
            ],
          },
        }),
      );
      ctx.mocks.apps.getConfig.mockResolvedValue({
        features: { viewerCounter: false },
      } as never);

      const rec = await svc.get(APP, 'live-room/pub');
      expect(rec?.viewers).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // stop()
  // -------------------------------------------------------------------------

  describe('stop()', () => {
    it('throws NotFound for an unknown stream', async () => {
      await expect(svc.stop(APP, 'nope')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('disconnects the participant and marks a webrtc stream ended', async () => {
      await svc.upsert(APP, 'live-room/pub', 'webrtc', 'live-room', 'pub');
      const client = fakeRoomClient({ rooms: [], participants: {} });
      withRoomClient(client);

      await svc.stop(APP, 'live-room/pub');

      expect(client.removeParticipant).toHaveBeenCalledWith('live-room', 'pub');
      const row = ctx.db
        .appDb(APP)
        .prepare("SELECT status, ended_at FROM streams WHERE stream_id='live-room/pub'")
        .get() as { status: string; ended_at: string | null };
      expect(row.status).toBe('ended');
      expect(row.ended_at).not.toBeNull();
    });

    it('does not attempt LiveKit teardown for an already-ended stream', async () => {
      await svc.upsert(APP, 'live-room/pub', 'webrtc', 'live-room', 'pub');
      ctx.db
        .appDb(APP)
        .prepare("UPDATE streams SET status='ended' WHERE stream_id='live-room/pub'")
        .run();
      const client = fakeRoomClient({ rooms: [], participants: {} });
      withRoomClient(client);

      await svc.stop(APP, 'live-room/pub');
      expect(client.removeParticipant).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // end() — webhook close path (participant_left / track_unpublished), no
  // LiveKit teardown.
  // -------------------------------------------------------------------------

  describe('end()', () => {
    it('marks an active stream ended without any LiveKit teardown', async () => {
      await svc.upsert(APP, 'live-room/pub', 'webrtc', 'live-room', 'pub');
      const client = fakeRoomClient({ rooms: [], participants: {} });
      withRoomClient(client);

      await svc.end(APP, 'live-room/pub');

      const row = ctx.db
        .appDb(APP)
        .prepare("SELECT status, ended_at FROM streams WHERE stream_id='live-room/pub'")
        .get() as { status: string; ended_at: string | null };
      expect(row.status).toBe('ended');
      expect(row.ended_at).not.toBeNull();
      // Unlike stop(), end() never disconnects a participant/room.
      expect(client.removeParticipant).not.toHaveBeenCalled();
      expect(client.deleteRoom).not.toHaveBeenCalled();
    });

    it('is a no-op for an unknown stream id (does not throw)', async () => {
      await expect(svc.end(APP, 'nope')).resolves.toBeUndefined();
    });

    it('is idempotent — ending an already-ended stream is a no-op', async () => {
      await svc.upsert(APP, 'live-room/pub', 'webrtc', 'live-room', 'pub');
      await svc.end(APP, 'live-room/pub');
      await expect(svc.end(APP, 'live-room/pub')).resolves.toBeUndefined();
      const row = ctx.db
        .appDb(APP)
        .prepare("SELECT status FROM streams WHERE stream_id='live-room/pub'")
        .get() as { status: string };
      expect(row.status).toBe('ended');
    });

    it('throws NotFound for an unknown app', async () => {
      await expect(svc.end('ghost', 'r/p')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  // -------------------------------------------------------------------------
  // snapshot() — cheap guard paths only (no ffmpeg invocation)
  // -------------------------------------------------------------------------

  describe('snapshot() guards', () => {
    it('rejects a blank roomName with BadRequest', async () => {
      await expect(
        svc.snapshot({ appName: APP, roomName: '   ' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects an unknown app with NotFound', async () => {
      await expect(
        svc.snapshot({ appName: 'ghost', roomName: 'live-room' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
