/**
 * Unit specs for VodsRepository (module recording-s3-vods).
 *
 * Runs against a REAL migrated, isolated per-app SQLite DB — the consolidated
 * apps/<name>/app.db reached via DbService.appDb(app) (harness
 * makeUnitContext → createTestDb). Covers insert/list/get, partial update
 * semantics, the metatags-backed egress lookup (json_extract), the
 * active-by-stream query and delete.
 */
import { makeUnitContext, type UnitContext } from '../../../test/helpers';
import { VodsRepository, type VodInsert } from './vods.repository';

const APP = 'live';

function insertFixture(
  repo: VodsRepository,
  over: Partial<VodInsert> = {},
): number {
  const base: VodInsert = {
    appId: 1,
    streamId: 'stream-a',
    room: 'live-room-a',
    name: 'rec.mp4',
    status: 'recording',
    localPath: '/data/apps/live/recordings/rec.mp4',
    startedAt: new Date().toISOString(),
    metatagsJson: JSON.stringify({ egressId: 'EG_1', mode: 'room-composite' }),
    ...over,
  };
  return repo.insert(APP, base);
}

describe('VodsRepository', () => {
  let ctx: UnitContext;
  let repo: VodsRepository;

  beforeEach(() => {
    ctx = makeUnitContext();
    repo = new VodsRepository(ctx.db);
  });

  afterEach(() => ctx.cleanup());

  describe('insert + findById (mapping)', () => {
    it('persists a row and maps snake_case → camelCase', () => {
      const id = insertFixture(repo);
      expect(id).toBeGreaterThan(0);
      const vod = repo.findById(APP, id);
      expect(vod).not.toBeNull();
      expect(vod).toMatchObject({
        id,
        appId: 1,
        streamId: 'stream-a',
        room: 'live-room-a',
        name: 'rec.mp4',
        status: 'recording',
        localPath: '/data/apps/live/recordings/rec.mp4',
      });
      // Columns not set on insert default to null.
      expect(vod?.fileKey).toBeNull();
      expect(vod?.snapshotKey).toBeNull();
      expect(vod?.publicUrl).toBeNull();
    });

    it('returns null for a missing id', () => {
      expect(repo.findById(APP, 9999)).toBeNull();
    });
  });

  describe('update (partial patch)', () => {
    it('writes only the provided columns and leaves others intact', () => {
      const id = insertFixture(repo);
      repo.update(APP, id, {
        status: 'ready',
        fileKey: 'streamhub/live/rec.mp4',
        sizeBytes: 12345,
        durationS: 42.5,
        width: 1280,
        height: 720,
        format: 'h264',
        snapshotKey: 'streamhub/live/rec.jpg',
      });
      const vod = repo.findById(APP, id);
      expect(vod).toMatchObject({
        status: 'ready',
        fileKey: 'streamhub/live/rec.mp4',
        sizeBytes: 12345,
        durationS: 42.5,
        width: 1280,
        height: 720,
        format: 'h264',
        snapshotKey: 'streamhub/live/rec.jpg',
      });
      // untouched
      expect(vod?.streamId).toBe('stream-a');
      expect(vod?.name).toBe('rec.mp4');
    });

    it('coerces undefined patch values to null', () => {
      const id = insertFixture(repo);
      repo.update(APP, id, { localPath: undefined });
      expect(repo.findById(APP, id)?.localPath).toBeNull();
    });

    it('is a no-op for an empty patch', () => {
      const id = insertFixture(repo);
      expect(() => repo.update(APP, id, {})).not.toThrow();
      expect(repo.findById(APP, id)?.status).toBe('recording');
    });

    it('round-trips metatags JSON', () => {
      const id = insertFixture(repo);
      const meta = { egressId: 'EG_9', partIndex: 3, isPart: true };
      repo.update(APP, id, { metatagsJson: JSON.stringify(meta) });
      expect(JSON.parse(repo.findById(APP, id)!.metatagsJson!)).toEqual(meta);
    });
  });

  describe('list (newest first + paging)', () => {
    it('orders by id DESC and honours limit/offset', () => {
      const ids = [0, 1, 2, 3, 4].map((i) =>
        insertFixture(repo, { name: `rec-${i}.mp4` }),
      );
      const all = repo.list(APP);
      expect(all.map((v) => v.id)).toEqual([...ids].reverse());

      const page = repo.list(APP, { limit: 2, offset: 1 });
      expect(page).toHaveLength(2);
      expect(page.map((v) => v.id)).toEqual([ids[3], ids[2]]);
    });

    it('returns an empty array for an app with no vods', () => {
      expect(repo.list(APP)).toEqual([]);
    });
  });

  describe('list filters + ordering + all', () => {
    /** Seed a VOD then patch size/status; returns the id. */
    function seed(
      over: Partial<VodInsert>,
      patch: { sizeBytes?: number; status?: VodInsert['status'] } = {},
    ): number {
      const id = insertFixture(repo, over);
      if (patch.sizeBytes !== undefined || patch.status !== undefined) {
        repo.update(APP, id, patch);
      }
      return id;
    }

    it('filters by room and by status', () => {
      seed({ room: 'room-a', status: 'ready' });
      seed({ room: 'room-b', status: 'ready' });
      const failedA = seed({ room: 'room-a' }, { status: 'failed' });

      expect(repo.list(APP, { room: 'room-a' }).map((v) => v.room)).toEqual([
        'room-a',
        'room-a',
      ]);
      const failed = repo.list(APP, { status: 'failed' });
      expect(failed).toHaveLength(1);
      expect(failed[0].id).toBe(failedA);
    });

    it('filters by since/until over started_at (inclusive)', () => {
      const older = seed({ startedAt: '2026-01-01T00:00:00.000Z' });
      const mid = seed({ startedAt: '2026-06-15T00:00:00.000Z' });
      const newer = seed({ startedAt: '2026-12-31T00:00:00.000Z' });

      const win = repo.list(APP, {
        since: '2026-06-01T00:00:00.000Z',
        until: '2026-07-01T00:00:00.000Z',
      });
      expect(win.map((v) => v.id)).toEqual([mid]);

      const fromMid = repo.list(APP, { since: '2026-06-15T00:00:00.000Z' });
      expect(fromMid.map((v) => v.id).sort()).toEqual([mid, newer].sort());
      expect(fromMid.map((v) => v.id)).not.toContain(older);
    });

    it('orders by size_bytes asc/desc with a stable id tiebreak', () => {
      const a = seed({ name: 'a.mp4' }, { sizeBytes: 100 });
      const b = seed({ name: 'b.mp4' }, { sizeBytes: 300 });
      const c = seed({ name: 'c.mp4' }, { sizeBytes: 200 });

      expect(
        repo.list(APP, { order: 'size_bytes', dir: 'asc' }).map((v) => v.id),
      ).toEqual([a, c, b]);
      expect(
        repo.list(APP, { order: 'size_bytes', dir: 'desc' }).map((v) => v.id),
      ).toEqual([b, c, a]);
    });

    it('orders by started_at asc', () => {
      const t1 = seed({ startedAt: '2026-01-01T00:00:00.000Z' });
      const t2 = seed({ startedAt: '2026-02-01T00:00:00.000Z' });
      const t3 = seed({ startedAt: '2026-03-01T00:00:00.000Z' });
      expect(
        repo.list(APP, { order: 'started_at', dir: 'asc' }).map((v) => v.id),
      ).toEqual([t1, t2, t3]);
    });

    it('all=true returns every matching row, ignoring limit/offset', () => {
      const ids = [0, 1, 2, 3, 4].map((i) => seed({ name: `r-${i}.mp4` }));
      const paged = repo.list(APP, { limit: 2 });
      expect(paged).toHaveLength(2);

      const everything = repo.list(APP, { all: true, limit: 2, offset: 3 });
      expect(everything).toHaveLength(ids.length);
    });

    it('all=true still honours filters', () => {
      seed({ room: 'keep', status: 'ready' });
      seed({ room: 'keep', status: 'ready' });
      seed({ room: 'drop', status: 'ready' });
      const kept = repo.list(APP, { all: true, room: 'keep' });
      expect(kept).toHaveLength(2);
      expect(kept.every((v) => v.room === 'keep')).toBe(true);
    });
  });

  describe('count + countByStatus', () => {
    function seedStatus(status: VodInsert['status'], room = 'r'): number {
      const id = insertFixture(repo, { room });
      repo.update(APP, id, { status });
      return id;
    }

    it('count() respects filters', () => {
      seedStatus('ready', 'room-a');
      seedStatus('ready', 'room-b');
      seedStatus('failed', 'room-a');

      expect(repo.count(APP)).toBe(3);
      expect(repo.count(APP, { room: 'room-a' })).toBe(2);
      expect(repo.count(APP, { status: 'ready' })).toBe(2);
      expect(repo.count(APP, { room: 'room-a', status: 'failed' })).toBe(1);
    });

    it('countByStatus() always returns all four keys', () => {
      seedStatus('ready');
      seedStatus('ready');
      seedStatus('failed');
      seedStatus('uploading');

      expect(repo.countByStatus(APP)).toEqual({
        ready: 2,
        failed: 1,
        uploading: 1,
        recording: 0,
      });
    });

    it('countByStatus() is all-zero for an empty app', () => {
      expect(repo.countByStatus(APP)).toEqual({
        recording: 0,
        uploading: 0,
        ready: 0,
        failed: 0,
      });
    });
  });

  describe('findByEgressId (metatags json_extract)', () => {
    it('finds the row whose metatags.egressId matches', () => {
      insertFixture(repo, { metatagsJson: JSON.stringify({ egressId: 'EG_A' }) });
      const wanted = insertFixture(repo, {
        name: 'wanted.mp4',
        metatagsJson: JSON.stringify({ egressId: 'EG_B' }),
      });
      const found = repo.findByEgressId(APP, 'EG_B');
      expect(found?.id).toBe(wanted);
      expect(found?.name).toBe('wanted.mp4');
    });

    it('returns null when no row carries the egress id', () => {
      insertFixture(repo);
      expect(repo.findByEgressId(APP, 'EG_MISSING')).toBeNull();
    });

    it('returns the newest match when the egress id repeats (split parts)', () => {
      const meta = JSON.stringify({ egressId: 'EG_DUP' });
      insertFixture(repo, { metatagsJson: meta });
      const newer = insertFixture(repo, { metatagsJson: meta });
      expect(repo.findByEgressId(APP, 'EG_DUP')?.id).toBe(newer);
    });
  });

  describe('findActiveByStream', () => {
    it('returns the latest recording/uploading vod for a stream', () => {
      insertFixture(repo, { streamId: 's1', status: 'ready' });
      const active = insertFixture(repo, { streamId: 's1', status: 'uploading' });
      expect(repo.findActiveByStream(APP, 's1')?.id).toBe(active);
    });

    it('ignores ready/failed vods', () => {
      insertFixture(repo, { streamId: 's2', status: 'ready' });
      insertFixture(repo, { streamId: 's2', status: 'failed' });
      expect(repo.findActiveByStream(APP, 's2')).toBeNull();
    });

    it('scopes to the requested stream id', () => {
      insertFixture(repo, { streamId: 'other', status: 'recording' });
      expect(repo.findActiveByStream(APP, 's3')).toBeNull();
    });
  });

  describe('delete', () => {
    it('removes the row', () => {
      const id = insertFixture(repo);
      repo.delete(APP, id);
      expect(repo.findById(APP, id)).toBeNull();
    });

    it('is a no-op for a missing id', () => {
      expect(() => repo.delete(APP, 424242)).not.toThrow();
    });
  });
});
