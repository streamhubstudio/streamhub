/**
 * settings.js — defaults/bounds MIRROR the core contract
 * (streamhub-core/src/modules/stream-health/stream-health.thresholds.ts);
 * this suite hard-codes the same values so a drift on either side fails a
 * test. Also covers the read-only per-room override read via node:sqlite.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import {
  BOUNDS,
  DEFAULTS,
  parseAppConfig,
  readRoomOverrides,
  resolveThresholds,
} from '../src/settings.js';

test('defaults mirror the core thresholds contract exactly', () => {
  assert.deepEqual(
    { ...DEFAULTS },
    {
      sample_interval_sec: 10,
      silence_db: -50,
      silence_duration_sec: 15,
      desync_ms: 200,
      stall_sec: 20,
      bitrate_drop_pct: 50,
      recover_samples: 2,
    },
  );
  assert.deepEqual(
    { ...BOUNDS },
    {
      sample_interval_sec: [2, 300],
      silence_db: [-120, 0],
      silence_duration_sec: [1, 600],
      desync_ms: [10, 10000],
      stall_sec: [2, 600],
      bitrate_drop_pct: [0, 95],
      recover_samples: [1, 10],
    },
  );
});

test('resolveThresholds layers app config then room override', () => {
  const t = resolveThresholds({ silence_db: -60, stall_sec: 40 }, { stall_sec: 10 });
  assert.equal(t.silence_db, -60);
  assert.equal(t.stall_sec, 10);
  assert.equal(t.desync_ms, 200);
});

test('resolveThresholds ignores invalid values (string coercion allowed)', () => {
  const t = resolveThresholds(
    { silence_db: 'loud', desync_ms: 99999999 },
    { stall_sec: '30' },
  );
  assert.equal(t.silence_db, -50);
  assert.equal(t.desync_ms, 200);
  assert.equal(t.stall_sec, 30);
});

test('parseAppConfig: object in, {} on garbage', () => {
  assert.deepEqual(parseAppConfig('{"stall_sec":30}'), { stall_sec: 30 });
  assert.deepEqual(parseAppConfig('nope'), {});
  assert.deepEqual(parseAppConfig('[1]'), {});
  assert.deepEqual(parseAppConfig(undefined), {});
});

test('readRoomOverrides: reads the core-written stream_settings table', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-settings-'));
  const dbFile = path.join(dir, 'stream-health.db');
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbFile);
    db.exec(
      `CREATE TABLE stream_settings (
         room TEXT PRIMARY KEY, config_json TEXT NOT NULL DEFAULT '{}',
         updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    );
    db.prepare('INSERT INTO stream_settings (room, config_json) VALUES (?, ?)').run(
      'cam-1',
      '{"silence_db":-35}',
    );
    db.prepare('INSERT INTO stream_settings (room, config_json) VALUES (?, ?)').run(
      'bad',
      'not json',
    );
    db.close();

    const map = await readRoomOverrides(dbFile);
    assert.deepEqual(map.get('cam-1'), { silence_db: -35 });
    assert.equal(map.has('bad'), false); // corrupt row skipped
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readRoomOverrides: missing db → empty map (core has not written yet)', async () => {
  const map = await readRoomOverrides('/nonexistent/dir/stream-health.db');
  assert.equal(map.size, 0);
});
