/**
 * Unit specs for VisionStore — the per-app, PER-MODEL vision db repository
 * (occupancy.db / counting.db / crowd.db / demography.db).
 *
 * Uses real (throwaway temp) SQLite files via the `fileFor` seam; no infra.
 * Covers: settings upsert/get round-trip (room-keyed, per model db), one write
 * per event table with correct column mapping, per-model isolation, countSince /
 * recentEvents reads, and the 30-day retention prune firing on write.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { RETENTION_DAYS, VisionStore } from './vision.store';

const APP = 'live';

describe('VisionStore', () => {
  let dir: string;
  let appDir: string;
  let store: VisionStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-store-'));
    appDir = path.join(dir, 'apps', APP);
    store = new VisionStore();
  });

  afterEach(() => {
    store.onModuleDestroy();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('stream settings', () => {
    it('upserts and reads back a per-room config, then overwrites', () => {
      const first = store.putSetting(APP, appDir, 'occupancy', 'gate', {
        zones: [{ id: 'z1', tag: 'store-a', detect: 'personas', points: [] }],
      });
      expect(first).toMatchObject({ room: 'gate' });
      expect(store.getSetting(APP, appDir, 'occupancy', 'gate')?.config).toEqual({
        zones: [{ id: 'z1', tag: 'store-a', detect: 'personas', points: [] }],
      });

      store.putSetting(APP, appDir, 'occupancy', 'gate', { zones: [] });
      expect(store.getSetting(APP, appDir, 'occupancy', 'gate')?.config).toEqual({
        zones: [],
      });
    });

    it('keeps settings ISOLATED per model db (same room, different model)', () => {
      store.putSetting(APP, appDir, 'occupancy', 'gate', { zones: [] });
      store.putSetting(APP, appDir, 'counting', 'gate', { lines: [], fps: 3.5 });
      expect(store.getSetting(APP, appDir, 'occupancy', 'gate')?.config).toEqual({
        zones: [],
      });
      expect(store.getSetting(APP, appDir, 'counting', 'gate')?.config).toEqual({
        lines: [],
        fps: 3.5,
      });
      // A model with no row for the room returns null.
      expect(store.getSetting(APP, appDir, 'crowd', 'gate')).toBeNull();
    });

    it('returns null for an absent setting', () => {
      expect(store.getSetting(APP, appDir, 'occupancy', 'ghost')).toBeNull();
    });

    it('writes each model db to its own <model>.db file', () => {
      store.putSetting(APP, appDir, 'occupancy', 'gate', { zones: [] });
      store.putSetting(APP, appDir, 'demography', 'gate', { intervalSec: 120, engine: 'local' });
      expect(fs.existsSync(path.join(appDir, 'occupancy', 'occupancy.db'))).toBe(true);
      expect(fs.existsSync(path.join(appDir, 'demography', 'demography.db'))).toBe(true);
    });
  });

  describe('event ingest + reads', () => {
    it('records one row per model table with mapped columns', () => {
      store.recordOccupancy(APP, appDir, 'gate', 'occupancy.session_started', {
        zone: 'z1',
        tag: 'store-a',
        kind: 'personas',
        nodeId: 'edge-1',
      });
      store.recordCount(APP, appDir, 'gate', 'count.in', {
        line: 'l1',
        tag: 'door',
        trackId: 't5',
      });
      store.recordCrowd(APP, appDir, 'gate', 'crowd.threshold', {
        zone: 'z1',
        count: 12,
        threshold: 10,
      });
      store.recordDemography(APP, appDir, 'gate', 'demography.face', {
        age: 32,
        ageRange: '25-34',
        gender: 'f',
        emotion: 'happy',
        engine: 'local',
      });

      const occ = store.recentEvents(APP, appDir, 'occupancy', 10);
      expect(occ).toHaveLength(1);
      expect(occ[0]).toMatchObject({ model: 'occupancy', room: 'gate', tag: 'store-a' });
      expect(occ[0].event).toBe('occupancy.session_started');

      const count = store.recentEvents(APP, appDir, 'counting', 10);
      expect(count[0].event).toBe('count.in');
      expect(count[0].data.direction).toBe('in');

      const crowd = store.recentEvents(APP, appDir, 'crowd', 10);
      expect(crowd[0].event).toBe('crowd.threshold');
      expect(crowd[0].data.alert).toBe(1);

      const demo = store.recentEvents(APP, appDir, 'demography', 10);
      expect(demo[0].event).toBe('demography.face');
      expect(demo[0].data.gender).toBe('f');
    });

    it('countSince counts only rows at/after the cutoff', () => {
      const db = store.db(APP, appDir, 'counting');
      // Insert an old row (40 days ago) directly, then a fresh one via the API.
      const old = new Date(Date.now() - 40 * 86400_000).toISOString();
      db.prepare(
        "INSERT INTO count_events (room, direction, ts) VALUES ('gate','in',?)",
      ).run(old);
      store.recordCount(APP, appDir, 'gate', 'count.in', {});
      const since = new Date(Date.now() - 86400_000).toISOString();
      // The old row is BOTH pruned (see below) and outside the window anyway.
      expect(store.countSince(APP, appDir, 'counting', since)).toBe(1);
    });

    it('prunes rows older than the retention horizon on write', () => {
      const db = store.db(APP, appDir, 'crowd');
      const stale = new Date(
        Date.now() - (RETENTION_DAYS + 5) * 86400_000,
      ).toISOString();
      db.prepare(
        "INSERT INTO crowd_events (room, count, ts) VALUES ('gate',3,?)",
      ).run(stale);
      expect(
        (db.prepare('SELECT COUNT(*) AS n FROM crowd_events').get() as { n: number }).n,
      ).toBe(1);
      // A fresh write triggers the prune of the stale row.
      store.recordCrowd(APP, appDir, 'gate', 'crowd.count', { count: 5 });
      const rows = store.recentEvents(APP, appDir, 'crowd', 10);
      expect(rows).toHaveLength(1);
      expect(rows[0].data.count).toBe(5);
    });

    it('recentEvents caps the limit and returns newest first', () => {
      for (let i = 0; i < 5; i++) {
        store.recordCount(APP, appDir, 'gate', 'count.in', { trackId: `t${i}` });
      }
      const rows = store.recentEvents(APP, appDir, 'counting', 3);
      expect(rows).toHaveLength(3);
      expect(rows[0].data.track_id).toBe('t4');
    });
  });
});
