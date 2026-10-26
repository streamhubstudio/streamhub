/**
 * Unit specs for the `/hls` edge/CDN cache policy (CLUSTER-ROADMAP §4 item #2).
 *
 * Pure header-policy function + the on-disk `#EXT-X-ENDLIST` finished-detection.
 * No Nest DI, no infra — just the policy and a temp file. Locks down the exact
 * Cache-Control / Content-Type semantics an edge/CDN proxy relies on:
 *   - `.ts` segments: immutable + 1y, ALWAYS (CDN knob irrelevant).
 *   - `.m3u8` playlists: no-cache when the knob is off; short live TTL +
 *     stale-while-revalidate when on; a longer TTL once finished (ENDLIST).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  HLS_SEGMENT_DURATION_S,
  hlsCacheHeaders,
  hlsFileKind,
  playlistIsFinished,
} from './hls-cache';

describe('hlsFileKind', () => {
  it('classifies playlists, segments and other files by extension', () => {
    expect(hlsFileKind('/x/index.m3u8')).toBe('playlist');
    expect(hlsFileKind('/x/segment_00042.ts')).toBe('segment');
    expect(hlsFileKind('/x/thumb.jpg')).toBe('other');
    expect(hlsFileKind('/x/index.m3u8?token=abc'.replace(/\?.*$/, ''))).toBe(
      'playlist',
    );
  });
});

describe('hlsCacheHeaders — segments', () => {
  const ts = '/apps/live/hls/room/segment_00001.ts';

  it('are immutable + long-cached with the correct Content-Type, CDN off', () => {
    const h = hlsCacheHeaders(ts, { cdn: false });
    expect(h['Cache-Control']).toBe('public, max-age=31536000, immutable');
    expect(h['Content-Type']).toBe('video/mp2t');
    expect(h['Access-Control-Allow-Origin']).toBe('*');
  });

  it('are unchanged by the CDN knob (segments are always cacheable)', () => {
    const off = hlsCacheHeaders(ts, { cdn: false });
    const on = hlsCacheHeaders(ts, { cdn: true });
    expect(on).toEqual(off);
  });
});

describe('hlsCacheHeaders — playlists', () => {
  const m3u8 = '/apps/live/hls/room/index.m3u8';

  it('are no-cache when the CDN knob is off (pre-CDN behavior)', () => {
    const h = hlsCacheHeaders(m3u8, { cdn: false });
    expect(h['Cache-Control']).toBe('no-cache, no-store, must-revalidate');
    expect(h['Content-Type']).toBe('application/vnd.apple.mpegurl');
    expect(h['Access-Control-Allow-Origin']).toBe('*');
  });

  it('are briefly cacheable + stale-while-revalidate while LIVE when the knob is on', () => {
    const h = hlsCacheHeaders(m3u8, { cdn: true, finished: false });
    const swr = Math.max(1, Math.floor(HLS_SEGMENT_DURATION_S / 2));
    expect(h['Cache-Control']).toBe(
      `public, max-age=1, stale-while-revalidate=${swr}`,
    );
    // sanity: the SWR window is ~half the segment duration and short.
    expect(swr).toBe(2);
    expect(h['Content-Type']).toBe('application/vnd.apple.mpegurl');
  });

  it('get a longer TTL once FINISHED (ENDLIST) when the knob is on', () => {
    const h = hlsCacheHeaders(m3u8, { cdn: true, finished: true });
    expect(h['Cache-Control']).toBe('public, max-age=3600');
  });

  it('stay no-cache when the knob is off even if finished', () => {
    const h = hlsCacheHeaders(m3u8, { cdn: false, finished: true });
    expect(h['Cache-Control']).toBe('no-cache, no-store, must-revalidate');
  });
});

describe('hlsCacheHeaders — other files', () => {
  it('only set CORS, leaving caching/content-type to server defaults', () => {
    const h = hlsCacheHeaders('/apps/live/hls/room/thumb.jpg', { cdn: true });
    expect(h['Access-Control-Allow-Origin']).toBe('*');
    expect(h['Cache-Control']).toBeUndefined();
    expect(h['Content-Type']).toBeUndefined();
  });
});

describe('playlistIsFinished', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hls-cache-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is true when the playlist carries #EXT-X-ENDLIST', () => {
    const p = path.join(dir, 'index.m3u8');
    fs.writeFileSync(
      p,
      '#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:4.0,\nseg0.ts\n#EXT-X-ENDLIST\n',
    );
    expect(playlistIsFinished(p)).toBe(true);
  });

  it('is false for a live playlist with no ENDLIST tag', () => {
    const p = path.join(dir, 'index.m3u8');
    fs.writeFileSync(p, '#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:4.0,\nseg0.ts\n');
    expect(playlistIsFinished(p)).toBe(false);
  });

  it('is false (not thrown) when the file does not exist', () => {
    expect(playlistIsFinished(path.join(dir, 'missing.m3u8'))).toBe(false);
  });
});
