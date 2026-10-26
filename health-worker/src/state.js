/**
 * Per-room threshold STATE MACHINE — PURE (state + sample + thresholds in,
 * events + status out; time is an explicit parameter, never Date.now()).
 *
 * Detector semantics:
 *   - stalled        LEVEL: secondsSinceAdvance ≥ stall_sec. Critical.
 *   - audio          LEVEL: no audio track at all (probe ran, none found), or
 *                    mean volume ≤ silence_db continuously for
 *                    ≥ silence_duration_sec. health.audio_lost on the rising
 *                    edge, health.audio_recovered after recover_samples clean
 *                    audio samples.
 *   - av_desync      LEVEL: |desyncMs| ≥ desync_ms. health.av_desync on the
 *                    rising edge (re-arms after recovery hysteresis).
 *   - bitrate_low    LEVEL: measured kbps < bitrate_drop_pct% of the rolling
 *                    healthy baseline (EMA). No dedicated event — feeds the
 *                    rollup only. 0 disables.
 *   - discontinuity  PULSE: dropped segments / CC errors / #EXT-X-DISCONTINUITY
 *                    tags in THIS sample. health.discontinuity at most once
 *                    per {@link DISCONTINUITY_COOLDOWN_SEC}; feeds the rollup
 *                    for the sample it occurs in.
 *
 * Rollup: critical when stalled OR ≥2 distinct issues; degraded when exactly
 * 1; healthy when clean for recover_samples consecutive samples (hysteresis).
 * health.degraded fires on every WORSENING transition (healthy→degraded,
 * healthy→critical, degraded→critical); health.recovered on →healthy.
 */

export const DISCONTINUITY_COOLDOWN_SEC = 60;

/** Fresh per-room state. */
export function createRoomState() {
  return {
    status: 'healthy',
    lastReasons: [],
    cleanStreak: 0,
    // audio
    audioLost: false,
    audioCleanStreak: 0,
    silentSinceMs: null,
    // desync
    desyncActive: false,
    desyncCleanStreak: 0,
    // stall
    stallActive: false,
    // discontinuity pulse cooldown
    lastDiscontinuityEmitMs: null,
    // rolling healthy-bitrate baseline (EMA)
    baselineKbps: null,
  };
}

/**
 * One sampling cycle for one room.
 *
 * @param {ReturnType<typeof createRoomState>} state  mutated in place.
 * @param {{
 *   secondsSinceAdvance: number,      // wallclock since the playlist last advanced
 *   droppedSegments?: number,
 *   ccErrors?: number,
 *   newDiscontinuityTags?: number,
 *   hasAudioTrack?: boolean|null,     // null/undefined = no probe this cycle
 *   meanDb?: number|null,             // null = volume unknown this cycle
 *   desyncMs?: number|null,
 *   measuredKbps?: number|null,
 * }} sample
 * @param {{
 *   silence_db: number, silence_duration_sec: number, desync_ms: number,
 *   stall_sec: number, bitrate_drop_pct: number, recover_samples: number,
 * }} t   resolved thresholds.
 * @param {number} nowMs
 * @returns {{ events: { event: string, data: Record<string, unknown> }[],
 *            status: string, reasons: string[] }}
 */
export function evaluate(state, sample, t, nowMs) {
  const events = [];
  const reasons = [];

  // --- stall (level, critical) ---------------------------------------------
  const stalled = sample.secondsSinceAdvance >= t.stall_sec;
  if (stalled) reasons.push('stalled');
  if (stalled && !state.stallActive) {
    events.push({
      event: 'health.stalled',
      data: { stalledForSec: Math.round(sample.secondsSinceAdvance) },
    });
  }
  state.stallActive = stalled;

  // --- audio (level) ---------------------------------------------------------
  let audioIssue = null;
  if (sample.hasAudioTrack === false) {
    audioIssue = 'audio_missing';
    state.silentSinceMs = null;
  } else if (typeof sample.meanDb === 'number') {
    if (sample.meanDb <= t.silence_db) {
      if (state.silentSinceMs === null) state.silentSinceMs = nowMs;
      const silentForSec = (nowMs - state.silentSinceMs) / 1000;
      if (silentForSec >= t.silence_duration_sec) audioIssue = 'audio_silent';
    } else {
      state.silentSinceMs = null;
    }
  }
  // (no probe this cycle → audio state coasts: no issue added, no recovery)
  const audioObserved = sample.hasAudioTrack === false || typeof sample.meanDb === 'number';

  if (audioIssue) {
    reasons.push(audioIssue);
    state.audioCleanStreak = 0;
    if (!state.audioLost) {
      state.audioLost = true;
      events.push({
        event: 'health.audio_lost',
        data:
          audioIssue === 'audio_missing'
            ? { reason: 'no_audio_track' }
            : {
                reason: 'silence',
                silenceDb: sample.meanDb,
                silentForSec: Math.round((nowMs - (state.silentSinceMs ?? nowMs)) / 1000),
              },
      });
    }
  } else if (audioObserved) {
    if (state.audioLost) {
      // An OBSERVED clean sample is evidence of health: it does not feed the
      // rollup reasons (otherwise detector + rollup hysteresis would stack to
      // 2× recover_samples). The streak only gates the audio_recovered event.
      state.audioCleanStreak++;
      if (state.audioCleanStreak >= t.recover_samples) {
        state.audioLost = false;
        state.audioCleanStreak = 0;
        events.push({ event: 'health.audio_recovered', data: {} });
      }
    }
  } else if (state.audioLost) {
    // No observation this cycle: coast the known-bad state.
    reasons.push('audio_silent');
  }

  // --- A/V desync (level) ----------------------------------------------------
  if (typeof sample.desyncMs === 'number') {
    const over = Math.abs(sample.desyncMs) >= t.desync_ms;
    if (over) {
      reasons.push('av_desync');
      state.desyncCleanStreak = 0;
      if (!state.desyncActive) {
        state.desyncActive = true;
        events.push({
          event: 'health.av_desync',
          data: { desyncMs: Math.round(sample.desyncMs) },
        });
      }
    } else if (state.desyncActive) {
      // Observed-clean: no rollup reason (see the audio note above); the
      // streak only gates the re-arm of the next av_desync edge.
      state.desyncCleanStreak++;
      if (state.desyncCleanStreak >= t.recover_samples) {
        state.desyncActive = false;
        state.desyncCleanStreak = 0;
      }
    }
  } else if (state.desyncActive) {
    // No desync measurement this cycle: coast the known-bad state.
    reasons.push('av_desync');
  }

  // --- discontinuities (pulse) ----------------------------------------------
  const dropped = sample.droppedSegments ?? 0;
  const ccErrors = sample.ccErrors ?? 0;
  const discTags = sample.newDiscontinuityTags ?? 0;
  if (dropped > 0 || ccErrors > 0 || discTags > 0) {
    reasons.push('discontinuity');
    const last = state.lastDiscontinuityEmitMs;
    if (last === null || nowMs - last >= DISCONTINUITY_COOLDOWN_SEC * 1000) {
      state.lastDiscontinuityEmitMs = nowMs;
      events.push({
        event: 'health.discontinuity',
        data: {
          droppedSegments: dropped,
          ccErrors,
          discontinuityTags: discTags,
        },
      });
    }
  }

  // --- bitrate drop vs rolling baseline (level, rollup-only) ------------------
  if (typeof sample.measuredKbps === 'number' && sample.measuredKbps > 0) {
    if (
      t.bitrate_drop_pct > 0 &&
      state.baselineKbps !== null &&
      sample.measuredKbps < (state.baselineKbps * t.bitrate_drop_pct) / 100
    ) {
      reasons.push('bitrate_low');
    } else {
      // Update the baseline ONLY with healthy-looking readings so a sustained
      // drop cannot drag its own reference down.
      state.baselineKbps =
        state.baselineKbps === null
          ? sample.measuredKbps
          : Math.round(state.baselineKbps * 0.8 + sample.measuredKbps * 0.2);
    }
  }

  // --- rollup ------------------------------------------------------------------
  const distinct = new Set(reasons);
  let target;
  if (stalled || distinct.size >= 2) target = 'critical';
  else if (distinct.size === 1) target = 'degraded';
  else target = 'healthy';

  if (target === 'healthy') {
    if (state.status !== 'healthy') {
      state.cleanStreak++;
      if (state.cleanStreak >= t.recover_samples) {
        const cleared = state.lastReasons;
        state.status = 'healthy';
        state.cleanStreak = 0;
        state.lastReasons = [];
        events.push({
          event: 'health.recovered',
          data: { status: 'healthy', clearedReasons: cleared },
        });
      }
    }
  } else {
    state.cleanStreak = 0;
    const rank = { healthy: 0, degraded: 1, critical: 2 };
    if (rank[target] > rank[state.status]) {
      events.push({
        event: 'health.degraded',
        data: { status: target, reasons: [...distinct] },
      });
    }
    state.status = target;
    state.lastReasons = [...distinct];
  }

  return { events, status: state.status, reasons: [...distinct] };
}
