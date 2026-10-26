/**
 * playlist.js — parse / diff / measured-bitrate. Pure text in, no fs.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { diffPlaylist, measuredKbps, parsePlaylist } from '../src/playlist.js';

const PL = (seq, uris, { endlist = false, discAt = -1 } = {}) =>
  [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:6',
    `#EXT-X-MEDIA-SEQUENCE:${seq}`,
    ...uris.flatMap((u, i) => [
      ...(i === discAt ? ['#EXT-X-DISCONTINUITY'] : []),
      '#EXTINF:6.000,',
      u,
    ]),
    ...(endlist ? ['#EXT-X-ENDLIST'] : []),
  ].join('\n');

test('parsePlaylist: sequence, target duration, segments with EXTINF', () => {
  const pl = parsePlaylist(PL(42, ['a.ts', 'b.ts', 'c.ts']));
  assert.equal(pl.mediaSequence, 42);
  assert.equal(pl.targetDuration, 6);
  assert.equal(pl.endlist, false);
  assert.equal(pl.segments.length, 3);
  assert.deepEqual(
    pl.segments.map((s) => s.seq),
    [42, 43, 44],
  );
  assert.equal(pl.segments[0].duration, 6);
});

test('parsePlaylist: discontinuity attaches to the FOLLOWING segment only', () => {
  const pl = parsePlaylist(PL(0, ['a.ts', 'b.ts', 'c.ts'], { discAt: 1 }));
  assert.deepEqual(
    pl.segments.map((s) => s.discontinuity),
    [false, true, false],
  );
});

test('parsePlaylist: EXT-X-DISCONTINUITY-SEQUENCE is NOT a discontinuity tag', () => {
  const text = '#EXTM3U\n#EXT-X-DISCONTINUITY-SEQUENCE:3\n#EXTINF:6,\na.ts\n';
  const pl = parsePlaylist(text);
  assert.equal(pl.segments[0].discontinuity, false);
});

test('parsePlaylist: ENDLIST and empty/garbage input', () => {
  assert.equal(parsePlaylist(PL(0, ['a.ts'], { endlist: true })).endlist, true);
  assert.deepEqual(parsePlaylist('').segments, []);
  assert.deepEqual(parsePlaylist(undefined).segments, []);
});

test('diffPlaylist: first poll sees everything as new, nothing dropped', () => {
  const curr = parsePlaylist(PL(10, ['a.ts', 'b.ts']));
  const d = diffPlaylist(null, curr);
  assert.equal(d.advanced, true);
  assert.equal(d.newSegments.length, 2);
  assert.equal(d.droppedSegments, 0);
});

test('diffPlaylist: normal advance yields only the new tail', () => {
  const prev = parsePlaylist(PL(10, ['a.ts', 'b.ts', 'c.ts']));
  const curr = parsePlaylist(PL(11, ['b.ts', 'c.ts', 'd.ts']));
  const d = diffPlaylist(prev, curr);
  assert.equal(d.advanced, true);
  assert.deepEqual(
    d.newSegments.map((s) => s.uri),
    ['d.ts'],
  );
  assert.equal(d.droppedSegments, 0);
});

test('diffPlaylist: identical polls = stall (no advance, nothing new)', () => {
  const prev = parsePlaylist(PL(10, ['a.ts', 'b.ts']));
  const curr = parsePlaylist(PL(10, ['a.ts', 'b.ts']));
  const d = diffPlaylist(prev, curr);
  assert.equal(d.advanced, false);
  assert.equal(d.newSegments.length, 0);
});

test('diffPlaylist: sequence jumping past the previous window = dropped segments', () => {
  // prev window [10, 13); next poll starts at 15 → segments 13, 14 were never seen.
  const prev = parsePlaylist(PL(10, ['a.ts', 'b.ts', 'c.ts']));
  const curr = parsePlaylist(PL(15, ['x.ts', 'y.ts', 'z.ts']));
  const d = diffPlaylist(prev, curr);
  assert.equal(d.droppedSegments, 2);
  assert.equal(d.advanced, true);
  assert.equal(d.newSegments.length, 3);
});

test('diffPlaylist: discontinuity tags counted only on NEW segments', () => {
  const prev = parsePlaylist(PL(0, ['a.ts', 'b.ts', 'c.ts'], { discAt: 1 }));
  // Window slides by one; the OLD tag on b.ts must not be re-counted; the new
  // segment d.ts carries a fresh tag.
  const curr = parsePlaylist(PL(1, ['b.ts', 'c.ts', 'd.ts'], { discAt: 2 }));
  const d = diffPlaylist(prev, curr);
  assert.equal(d.newDiscontinuityTags, 1);
  assert.deepEqual(
    d.newSegments.map((s) => s.uri),
    ['d.ts'],
  );
});

test('measuredKbps: bytes over seconds, null when nothing new', () => {
  // 1_500_000 bytes over 6 s = 2000 kbps.
  assert.equal(measuredKbps([{ bytes: 1_500_000, duration: 6 }]), 2000);
  assert.equal(
    measuredKbps([
      { bytes: 750_000, duration: 3 },
      { bytes: 750_000, duration: 3 },
    ]),
    2000,
  );
  assert.equal(measuredKbps([]), null);
  assert.equal(measuredKbps([{ bytes: 0, duration: 6 }]), null);
  assert.equal(measuredKbps([{ bytes: Number.NaN, duration: 6 }]), null);
});
