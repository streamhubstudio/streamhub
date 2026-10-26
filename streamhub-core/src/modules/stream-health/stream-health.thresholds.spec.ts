/**
 * Unit spec — the pure thresholds contract. Locks the default values (which
 * the plugin.meta configSchema AND health-worker/src/settings.js mirror), the
 * override sanitizer (unknown key / non-number / out-of-range → error) and
 * the three-layer resolution (defaults ⊕ install config ⊕ room override,
 * with invalid lower-layer values falling through, never throwing).
 */
import {
  DEFAULT_THRESHOLDS,
  HealthSettingsError,
  resolveThresholds,
  sanitizeOverride,
  THRESHOLD_BOUNDS,
} from './stream-health.thresholds';

describe('stream-health thresholds', () => {
  it('locks the default values the meta + worker mirror', () => {
    expect(DEFAULT_THRESHOLDS).toEqual({
      sample_interval_sec: 10,
      silence_db: -50,
      silence_duration_sec: 15,
      desync_ms: 200,
      stall_sec: 20,
      bitrate_drop_pct: 50,
      recover_samples: 2,
    });
    // Every default sits within its own bounds.
    for (const [key, [min, max]] of Object.entries(THRESHOLD_BOUNDS)) {
      const v = DEFAULT_THRESHOLDS[key as keyof typeof DEFAULT_THRESHOLDS];
      expect(v).toBeGreaterThanOrEqual(min);
      expect(v).toBeLessThanOrEqual(max);
    }
  });

  describe('sanitizeOverride', () => {
    it('accepts a partial with numeric strings coerced', () => {
      expect(sanitizeOverride({ silence_db: '-40', stall_sec: 30 })).toEqual({
        silence_db: -40,
        stall_sec: 30,
      });
    });

    it('accepts {} / null / undefined as "no override"', () => {
      expect(sanitizeOverride({})).toEqual({});
      expect(sanitizeOverride(null)).toEqual({});
      expect(sanitizeOverride(undefined)).toEqual({});
    });

    it('rejects unknown keys (a typo must not silently no-op)', () => {
      expect(() => sanitizeOverride({ silence: -40 })).toThrow(HealthSettingsError);
    });

    it('rejects non-numbers and out-of-range values', () => {
      expect(() => sanitizeOverride({ silence_db: 'quiet' })).toThrow(
        HealthSettingsError,
      );
      expect(() => sanitizeOverride({ silence_db: 5 })).toThrow(HealthSettingsError);
      expect(() => sanitizeOverride({ recover_samples: 0 })).toThrow(
        HealthSettingsError,
      );
      expect(() => sanitizeOverride({ desync_ms: Number.NaN })).toThrow(
        HealthSettingsError,
      );
    });

    it('rejects non-object bodies', () => {
      expect(() => sanitizeOverride([1])).toThrow(HealthSettingsError);
      expect(() => sanitizeOverride('x')).toThrow(HealthSettingsError);
    });
  });

  describe('resolveThresholds', () => {
    it('layers install config over defaults, room override over both', () => {
      const resolved = resolveThresholds(
        { silence_db: -60, stall_sec: 40 },
        { stall_sec: 10 },
      );
      expect(resolved.silence_db).toBe(-60); // install config
      expect(resolved.stall_sec).toBe(10); // room override wins
      expect(resolved.desync_ms).toBe(200); // default
    });

    it('ignores invalid lower-layer values instead of throwing', () => {
      const resolved = resolveThresholds(
        { silence_db: 'loud', desync_ms: 999999, extraneous: true },
        null,
      );
      expect(resolved.silence_db).toBe(-50);
      expect(resolved.desync_ms).toBe(200);
    });

    it('with no layers returns the defaults (fresh copy, not the constant)', () => {
      const resolved = resolveThresholds();
      expect(resolved).toEqual(DEFAULT_THRESHOLDS);
      expect(resolved).not.toBe(DEFAULT_THRESHOLDS);
    });
  });
});
