/**
 * state.js — the per-room threshold state machine. Time is an explicit
 * parameter, so every hysteresis/cooldown scenario is deterministic.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createRoomState,
  DISCONTINUITY_COOLDOWN_SEC,
  evaluate,
} from '../src/state.js';

const T = {
  sample_interval_sec: 10,
  silence_db: -50,
  silence_duration_sec: 15,
  desync_ms: 200,
  stall_sec: 20,
  bitrate_drop_pct: 50,
  recover_samples: 2,
};

/** A perfectly healthy sample. */
const good = (over = {}) => ({
  secondsSinceAdvance: 2,
  droppedSegments: 0,
  ccErrors: 0,
  newDiscontinuityTags: 0,
  hasAudioTrack: true,
  meanDb: -23,
  desyncMs: 10,
  measuredKbps: 2000,
  ...over,
});

const names = (r) => r.events.map((e) => e.event);

test('healthy stream: no events, healthy status', () => {
  const s = createRoomState();
  const r = evaluate(s, good(), T, 0);
  assert.deepEqual(r.events, []);
  assert.equal(r.status, 'healthy');
  assert.deepEqual(r.reasons, []);
});

test('stall: edge event + critical rollup, no repeat while stalled, recovery hysteresis', () => {
  const s = createRoomState();
  let r = evaluate(s, good({ secondsSinceAdvance: 25 }), T, 0);
  assert.deepEqual(names(r), ['health.stalled', 'health.degraded']);
  assert.equal(r.status, 'critical'); // stall is always critical
  assert.equal(r.events[1].data.status, 'critical');
  assert.deepEqual(r.events[1].data.reasons, ['stalled']);

  // Still stalled: no duplicate edge events.
  r = evaluate(s, good({ secondsSinceAdvance: 35 }), T, 10_000);
  assert.deepEqual(r.events, []);

  // First clean sample: hysteresis holds (recover_samples = 2).
  r = evaluate(s, good(), T, 20_000);
  assert.deepEqual(r.events, []);
  assert.equal(r.status, 'critical');

  // Second clean sample: recovered, clearedReasons carried.
  r = evaluate(s, good(), T, 30_000);
  assert.deepEqual(names(r), ['health.recovered']);
  assert.deepEqual(r.events[0].data.clearedReasons, ['stalled']);
  assert.equal(r.status, 'healthy');
});

test('audio silence: needs silence_duration before tripping, then recovers with hysteresis', () => {
  const s = createRoomState();
  // Silent but not long enough (t=0 starts the clock).
  let r = evaluate(s, good({ meanDb: -80 }), T, 0);
  assert.deepEqual(r.events, []);
  assert.equal(r.status, 'healthy');

  // 10 s silent — still under 15 s.
  r = evaluate(s, good({ meanDb: -85 }), T, 10_000);
  assert.deepEqual(r.events, []);

  // 20 s silent — trip.
  r = evaluate(s, good({ meanDb: -90 }), T, 20_000);
  assert.deepEqual(names(r), ['health.audio_lost', 'health.degraded']);
  assert.equal(r.events[0].data.reason, 'silence');
  assert.equal(r.events[0].data.silenceDb, -90);
  assert.equal(r.status, 'degraded');

  // Audio back, sample 1: hysteresis — no events yet, but the observed-clean
  // sample no longer feeds the rollup reasons (streaks never stack).
  r = evaluate(s, good(), T, 30_000);
  assert.deepEqual(r.events, []);
  assert.deepEqual(r.reasons, []);
  assert.equal(r.status, 'degraded'); // rollup hysteresis still holding

  // Sample 2: audio_recovered + rollup recovered (streaks aligned).
  r = evaluate(s, good(), T, 40_000);
  assert.ok(names(r).includes('health.audio_recovered'));
  assert.ok(names(r).includes('health.recovered'));
  assert.equal(r.status, 'healthy');
});

test('a gap in loudness resets the silence clock (no false audio_lost)', () => {
  const s = createRoomState();
  evaluate(s, good({ meanDb: -80 }), T, 0);
  evaluate(s, good({ meanDb: -20 }), T, 10_000); // loud again
  const r = evaluate(s, good({ meanDb: -80 }), T, 20_000); // silent restarts at 20s
  assert.deepEqual(r.events, []); // 0 s of continuous silence so far
});

test('missing audio track trips immediately (no duration wait)', () => {
  const s = createRoomState();
  const r = evaluate(s, good({ hasAudioTrack: false, meanDb: null }), T, 0);
  assert.deepEqual(names(r), ['health.audio_lost', 'health.degraded']);
  assert.equal(r.events[0].data.reason, 'no_audio_track');
});

test('no probe this cycle (stall): audio state coasts without recovery', () => {
  const s = createRoomState();
  evaluate(s, good({ hasAudioTrack: false, meanDb: null }), T, 0);
  // Next cycle has no new segment → no audio observation at all.
  const r = evaluate(
    s,
    good({ hasAudioTrack: null, meanDb: null }),
    T,
    10_000,
  );
  assert.ok(!names(r).includes('health.audio_recovered'));
  assert.deepEqual(r.reasons, ['audio_silent']);
});

test('A/V desync: edge event, hold, recover, and re-arm for the next incident', () => {
  const s = createRoomState();
  let r = evaluate(s, good({ desyncMs: 350 }), T, 0);
  assert.deepEqual(names(r), ['health.av_desync', 'health.degraded']);
  assert.equal(r.events[0].data.desyncMs, 350);

  // Still desynced: no repeat.
  r = evaluate(s, good({ desyncMs: 400 }), T, 10_000);
  assert.deepEqual(r.events, []);

  // Two clean samples → recovered.
  evaluate(s, good(), T, 20_000);
  r = evaluate(s, good(), T, 30_000);
  assert.deepEqual(names(r), ['health.recovered']);

  // A NEW desync incident fires again.
  r = evaluate(s, good({ desyncMs: 500 }), T, 40_000);
  assert.ok(names(r).includes('health.av_desync'));
});

test('discontinuity: pulse with cooldown, feeds the rollup for its sample', () => {
  const s = createRoomState();
  let r = evaluate(s, good({ ccErrors: 7 }), T, 0);
  assert.deepEqual(names(r), ['health.discontinuity', 'health.degraded']);
  assert.equal(r.events[0].data.ccErrors, 7);

  // Within the cooldown: the condition still degrades, but no event spam.
  r = evaluate(s, good({ droppedSegments: 2 }), T, 30_000);
  assert.deepEqual(r.events, []);
  assert.deepEqual(r.reasons, ['discontinuity']);

  // After the cooldown a fresh pulse fires.
  r = evaluate(
    s,
    good({ newDiscontinuityTags: 1 }),
    T,
    (DISCONTINUITY_COOLDOWN_SEC + 31) * 1000,
  );
  assert.ok(names(r).includes('health.discontinuity'));
});

test('bitrate drop: baseline learned when healthy, drop degrades, no self-drag', () => {
  const s = createRoomState();
  evaluate(s, good({ measuredKbps: 2000 }), T, 0); // baseline = 2000
  // 800 < 50% of 2000 → degraded; baseline must NOT absorb the bad reading.
  let r = evaluate(s, good({ measuredKbps: 800 }), T, 10_000);
  assert.deepEqual(names(r), ['health.degraded']);
  assert.deepEqual(r.events[0].data.reasons, ['bitrate_low']);
  assert.equal(s.baselineKbps, 2000);

  // Back over the bar for two samples → recovered.
  evaluate(s, good({ measuredKbps: 1900 }), T, 20_000);
  r = evaluate(s, good({ measuredKbps: 2000 }), T, 30_000);
  assert.deepEqual(names(r), ['health.recovered']);
});

test('bitrate_drop_pct = 0 disables the bitrate check entirely', () => {
  const s = createRoomState();
  const t = { ...T, bitrate_drop_pct: 0 };
  evaluate(s, good({ measuredKbps: 2000 }), t, 0);
  const r = evaluate(s, good({ measuredKbps: 100 }), t, 10_000);
  assert.deepEqual(r.events, []);
  assert.equal(r.status, 'healthy');
});

test('two distinct issues roll up to critical; worsening fires degraded again', () => {
  const s = createRoomState();
  // One issue → degraded.
  let r = evaluate(s, good({ desyncMs: 400 }), T, 0);
  assert.equal(r.status, 'degraded');
  // Second issue joins → escalation event to critical.
  r = evaluate(s, good({ desyncMs: 400, ccErrors: 3 }), T, 10_000);
  assert.equal(r.status, 'critical');
  const degraded = r.events.find((e) => e.event === 'health.degraded');
  assert.ok(degraded);
  assert.equal(degraded.data.status, 'critical');
  assert.deepEqual(new Set(degraded.data.reasons), new Set(['av_desync', 'discontinuity']));
});

test('no de-escalation event on critical → degraded (only full recovery emits)', () => {
  const s = createRoomState();
  evaluate(s, good({ desyncMs: 400, ccErrors: 3 }), T, 0); // critical
  const r = evaluate(s, good({ desyncMs: 400 }), T, 10_000); // one issue left
  assert.deepEqual(r.events, []);
  assert.equal(r.status, 'degraded');
});

test('recover_samples = 1 recovers on the first clean sample', () => {
  const s = createRoomState();
  const t = { ...T, recover_samples: 1 };
  evaluate(s, good({ desyncMs: 400 }), t, 0);
  const r = evaluate(s, good(), t, 10_000);
  assert.deepEqual(names(r), ['health.recovered']);
});
