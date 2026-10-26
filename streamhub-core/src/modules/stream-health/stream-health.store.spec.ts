/**
 * Unit spec — the per-app stream-health SQLite store (real better-sqlite3 on
 * a temp dir; no infrastructure). Locks: schema creation on first touch,
 * event recording with status/reasons extraction + retention pruning, the
 * newest-first capped reads (global + per-room), the roomsSince latest-event
 * projection, and the per-room override upsert/list round-trip.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { StreamHealthStore, RETENTION_DAYS } from './stream-health.store';

describe('StreamHealthStore', () => {
  let dir: string;
  let store: StreamHealthStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-store-'));
    store = new StreamHealthStore();
  });

  afterEach(() => {
    store.onModuleDestroy();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates the db under <appDir>/stream-health/ and records events', () => {
    store.record(
      'live',
      dir,
      'cam-1',
      'health.degraded',
      { status: 'degraded', reasons: ['audio_silent', 'av_desync'], desyncMs: 320 },
    );
    expect(fs.existsSync(path.join(dir, 'stream-health', 'stream-health.db'))).toBe(true);

    const rows = store.recentEvents('live', dir, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0].room).toBe('cam-1');
    expect(rows[0].event).toBe('health.degraded');
    expect(rows[0].status).toBe('degraded');
    expect(rows[0].reasons).toBe('audio_silent,av_desync');
    expect(rows[0].data.desyncMs).toBe(320);
  });

  it('reads newest-first, caps the limit, and scopes by room', () => {
    for (let i = 0; i < 5; i++) {
      store.record('live', dir, i % 2 ? 'a' : 'b', 'health.stalled', { i });
    }
    const all = store.recentEvents('live', dir, 3);
    expect(all).toHaveLength(3);
    expect(all[0].data.i).toBe(4); // newest first

    const onlyA = store.recentEvents('live', dir, 10, 'a');
    expect(onlyA.every((r) => r.room === 'a')).toBe(true);
    expect(onlyA).toHaveLength(2);

    // Garbage limits fall back to a sane cap.
    expect(store.recentEvents('live', dir, Number.NaN).length).toBe(5);
  });

  it('prunes rows older than the retention horizon on write', () => {
    store.record('live', dir, 'cam-1', 'health.stalled', {});
    // Back-date the row beyond the horizon.
    const old = new Date(
      Date.now() - (RETENTION_DAYS + 1) * 86400_000,
    ).toISOString();
    store.db('live', dir).prepare('UPDATE health_events SET ts = ?').run(old);

    store.record('live', dir, 'cam-1', 'health.recovered', {});
    const rows = store.recentEvents('live', dir, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0].event).toBe('health.recovered');
  });

  it('projects the latest event per room since a cutoff', () => {
    store.record('live', dir, 'a', 'health.degraded', {});
    store.record('live', dir, 'a', 'health.recovered', {});
    store.record('live', dir, 'b', 'health.stalled', {});
    const rooms = store.roomsSince(
      'live',
      dir,
      new Date(Date.now() - 60_000).toISOString(),
    );
    expect(rooms).toEqual([
      expect.objectContaining({ room: 'a', lastEvent: 'health.recovered' }),
      expect.objectContaining({ room: 'b', lastEvent: 'health.stalled' }),
    ]);
  });

  it('counts events since a cutoff', () => {
    store.record('live', dir, 'a', 'health.degraded', {});
    store.record('live', dir, 'a', 'health.recovered', {});
    const since = new Date(Date.now() - 60_000).toISOString();
    expect(store.countSince('live', dir, since)).toBe(2);
    expect(store.countSince('live', dir, new Date(Date.now() + 60_000).toISOString())).toBe(0);
  });

  it('round-trips per-room overrides (upsert wins, list is room-sorted)', () => {
    expect(store.getSetting('live', dir, 'cam-1')).toBeNull();

    store.putSetting('live', dir, 'cam-1', { silence_db: -40 });
    store.putSetting('live', dir, 'cam-1', { silence_db: -35, stall_sec: 30 });
    store.putSetting('live', dir, 'aaa', {});

    const row = store.getSetting('live', dir, 'cam-1');
    expect(row?.override).toEqual({ silence_db: -35, stall_sec: 30 });
    expect(row?.updatedAt).toBeTruthy();

    const list = store.listSettings('live', dir);
    expect(list.map((s) => s.room)).toEqual(['aaa', 'cam-1']);
  });

  it('survives a corrupt data_json/config_json cell (maps to empty)', () => {
    store.record('live', dir, 'a', 'health.stalled', {});
    store.putSetting('live', dir, 'a', {});
    const db = store.db('live', dir);
    db.prepare("UPDATE health_events SET data_json = 'not json'").run();
    db.prepare("UPDATE stream_settings SET config_json = '['").run();
    expect(store.recentEvents('live', dir, 1)[0].data).toEqual({});
    expect(store.getSetting('live', dir, 'a')?.override).toEqual({});
  });
});
