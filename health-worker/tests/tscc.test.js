/**
 * tscc.js — MPEG-TS continuity-counter analysis over SYNTHETIC packet
 * buffers (no real media anywhere near these tests).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { analyzeTsContinuity, isTsSegment, TS_PACKET_SIZE } from '../src/tscc.js';

/** Build one 188-byte TS packet. */
function packet(pid, cc, { payload = true, discontinuity = false } = {}) {
  const b = Buffer.alloc(TS_PACKET_SIZE, 0xff);
  b[0] = 0x47;
  b[1] = (pid >> 8) & 0x1f;
  b[2] = pid & 0xff;
  const afc = (discontinuity ? 0x2 : 0) | (payload ? 0x1 : 0) || 0x2;
  b[3] = (afc << 4) | (cc & 0x0f);
  if (afc & 0x2) {
    b[4] = 1; // adaptation field length
    b[5] = discontinuity ? 0x80 : 0x00;
  }
  return b;
}

const buf = (...pkts) => Buffer.concat(pkts);

test('clean CC sequence has zero errors', () => {
  const r = analyzeTsContinuity(
    buf(packet(0x100, 0), packet(0x100, 1), packet(0x100, 2), packet(0x100, 3)),
  );
  assert.equal(r.packets, 4);
  assert.equal(r.ccErrors, 0);
  assert.equal(r.pids, 1);
});

test('CC wraps 15 → 0 without an error', () => {
  const r = analyzeTsContinuity(buf(packet(0x100, 15), packet(0x100, 0)));
  assert.equal(r.ccErrors, 0);
});

test('a skipped CC counts as one error (lost packet)', () => {
  const r = analyzeTsContinuity(
    buf(packet(0x100, 0), packet(0x100, 1), packet(0x100, 3)),
  );
  assert.equal(r.ccErrors, 1);
});

test('per-PID tracking: independent counters never cross-fire', () => {
  const r = analyzeTsContinuity(
    buf(packet(0x100, 0), packet(0x101, 7), packet(0x100, 1), packet(0x101, 8)),
  );
  assert.equal(r.ccErrors, 0);
  assert.equal(r.pids, 2);
});

test('a duplicate packet (same CC repeated once) is legal', () => {
  const r = analyzeTsContinuity(
    buf(packet(0x100, 4), packet(0x100, 4), packet(0x100, 5)),
  );
  assert.equal(r.ccErrors, 0);
});

test('discontinuity_indicator suppresses the expected-CC check', () => {
  const r = analyzeTsContinuity(
    buf(packet(0x100, 2), packet(0x100, 9, { discontinuity: true })),
  );
  assert.equal(r.ccErrors, 0);
});

test('null packets (PID 0x1FFF) are ignored entirely', () => {
  const r = analyzeTsContinuity(
    buf(packet(0x1fff, 0), packet(0x1fff, 9), packet(0x1fff, 3)),
  );
  assert.equal(r.ccErrors, 0);
  assert.equal(r.pids, 0);
});

test('adaptation-only packets (no payload) do not advance the CC', () => {
  const r = analyzeTsContinuity(
    buf(
      packet(0x100, 5),
      packet(0x100, 5, { payload: false }),
      packet(0x100, 6),
    ),
  );
  assert.equal(r.ccErrors, 0);
});

test('lost sync is detected and resynced by scanning', () => {
  const junk = Buffer.alloc(41, 0x00);
  const r = analyzeTsContinuity(buf(packet(0x100, 0), junk, packet(0x100, 1)));
  assert.equal(r.syncLosses, 1);
  assert.equal(r.packets, 2);
  assert.equal(r.ccErrors, 0);
});

test('truncated tail (partial packet) is ignored, empty/garbage input is safe', () => {
  const r = analyzeTsContinuity(
    buf(packet(0x100, 0)).subarray(0, TS_PACKET_SIZE + 100),
  );
  assert.equal(r.packets, 1);
  assert.deepEqual(analyzeTsContinuity(Buffer.alloc(0)), {
    packets: 0,
    ccErrors: 0,
    syncLosses: 0,
    pids: 0,
  });
  assert.equal(analyzeTsContinuity(null).packets, 0);
});

test('isTsSegment matches .ts (with query) only', () => {
  assert.equal(isTsSegment('seg-1.ts'), true);
  assert.equal(isTsSegment('seg-1.ts?v=2'), true);
  assert.equal(isTsSegment('seg-1.m4s'), false);
  assert.equal(isTsSegment('seg-1.mp4'), false);
  assert.equal(isTsSegment(''), false);
});
