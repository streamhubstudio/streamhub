/**
 * Unit spec — DVR segment-retention janitor (QW-4).
 *
 * A DVR/always-on HLS room grows a full `index.m3u8` timeline forever; the
 * janitor prunes `.ts` older than the DVR window, but NEVER a segment still
 * referenced by the live (rolling) playlist. Pins:
 *   1. pure decision: newer-than-window survive, older removed, referenced kept;
 *   2. fs prune over a real temp dir: same behaviour end-to-end;
 *   3. safety: with no live playlist the janitor deletes nothing;
 *   4. playlist parsing ignores tags/blank lines and query strings.
 *
 * No infra: pure logic + a throwaway temp directory.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  parsePlaylistSegments,
  pruneDvrDir,
  safeRoomSlug,
  selectExpiredSegments,
} from './hls-dvr-janitor';

const HOUR_MS = 3600 * 1000;

describe('hls-dvr-janitor — selectExpiredSegments (pure)', () => {
  const now = 1_000_000_000_000;

  it('removes only segments older than the window and not referenced', () => {
    const out = selectExpiredSegments({
      now,
      windowMs: HOUR_MS,
      referenced: new Set(['seg_ref.ts']),
      segments: [
        { name: 'seg_recent.ts', mtimeMs: now - 60_000 }, // within window → keep
        { name: 'seg_old.ts', mtimeMs: now - 2 * HOUR_MS }, // old, unref → delete
        { name: 'seg_ref.ts', mtimeMs: now - 5 * HOUR_MS }, // old BUT referenced → keep
      ],
    });
    expect(out).toEqual(['seg_old.ts']);
  });

  it('a referenced segment is never selected even if ancient', () => {
    const out = selectExpiredSegments({
      now,
      windowMs: 1000,
      referenced: new Set(['a.ts']),
      segments: [{ name: 'a.ts', mtimeMs: 0 }],
    });
    expect(out).toEqual([]);
  });
});

describe('hls-dvr-janitor — parsePlaylistSegments', () => {
  it('extracts .ts basenames, ignoring tags/blank lines and query strings', () => {
    const m3u8 = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXTINF:4.000,',
      'segment_00010.ts',
      '',
      '#EXTINF:4.000,',
      'sub/segment_00011.ts?token=abc',
      '#EXT-X-ENDLIST',
    ].join('\n');
    const set = parsePlaylistSegments(m3u8);
    expect(set.has('segment_00010.ts')).toBe(true);
    expect(set.has('segment_00011.ts')).toBe(true);
    expect(set.size).toBe(2);
  });
});

describe('hls-dvr-janitor — pruneDvrDir (fs)', () => {
  let dir: string;
  const now = Date.now();

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvr-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Write a segment and backdate its mtime by `ageMs`. */
  function seg(name: string, ageMs: number): void {
    const p = path.join(dir, name);
    fs.writeFileSync(p, 'x');
    const t = new Date(now - ageMs);
    fs.utimesSync(p, t, t);
  }

  it('deletes only old, unreferenced segments (referenced + recent survive)', () => {
    seg('seg_old.ts', 2 * HOUR_MS); // old + unreferenced → delete
    seg('seg_recent.ts', 60_000); // recent → keep
    seg('seg_ref_old.ts', 3 * HOUR_MS); // old BUT referenced → keep
    // Live rolling playlist references the recent + the old-but-live segment.
    fs.writeFileSync(
      path.join(dir, 'live.m3u8'),
      '#EXTM3U\nseg_recent.ts\nseg_ref_old.ts\n',
    );

    const res = pruneDvrDir(dir, 3600, { now });

    expect(res.deleted).toEqual(['seg_old.ts']);
    expect(fs.existsSync(path.join(dir, 'seg_old.ts'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'seg_recent.ts'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'seg_ref_old.ts'))).toBe(true);
    expect(res.kept).toBe(2);
  });

  it('does nothing when the live playlist is absent (safety guard)', () => {
    seg('seg_old.ts', 5 * HOUR_MS);

    const res = pruneDvrDir(dir, 3600, { now });

    expect(res.deleted).toEqual([]);
    expect(fs.existsSync(path.join(dir, 'seg_old.ts'))).toBe(true);
  });

  it('no-op on a missing directory', () => {
    const res = pruneDvrDir(path.join(dir, 'nope'), 3600, { now });
    expect(res).toEqual({ deleted: [], kept: 0 });
  });
});

describe('hls-dvr-janitor — safeRoomSlug', () => {
  it('mirrors HlsService.safe (non [A-Za-z0-9_-] → _)', () => {
    expect(safeRoomSlug('live-ch1')).toBe('live-ch1');
    expect(safeRoomSlug('live/ch 1')).toBe('live_ch_1');
  });
});
