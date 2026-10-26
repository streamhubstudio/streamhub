/**
 * STREAM-HEALTH thresholds — the ONE pure definition of the detector knobs.
 *
 * Three layers, later wins:
 *   1. {@link DEFAULT_THRESHOLDS}   (mirrors the plugin.meta configSchema)
 *   2. the app-level install config (PATCH /apps/:app/plugins/stream-health)
 *   3. the per-room override        (PUT …/streams/:room/settings, stored in
 *                                    stream-health.db)
 *
 * The worker resolves the same three layers on its side (layer 2 arrives as
 * HEALTH_CONFIG_JSON in its env, layer 3 read from the db each cycle), so this
 * module and health-worker/src/settings.js MUST agree on keys + defaults —
 * both are locked by unit tests against these values.
 */

/** Detector thresholds, all numeric. */
export interface HealthThresholds {
  /** Probe cadence in seconds. */
  sample_interval_sec: number;
  /** Mean segment volume (dBFS) at or below which audio counts as silent. */
  silence_db: number;
  /** Continuous silence (s) required to fire health.audio_lost. */
  silence_duration_sec: number;
  /** |audio-video| timestamp drift (ms) firing health.av_desync. */
  desync_ms: number;
  /** No playlist progress for this long (s) fires health.stalled. */
  stall_sec: number;
  /** Measured bitrate below this % of the rolling baseline = degraded. 0 = off. */
  bitrate_drop_pct: number;
  /** Consecutive clean samples before health.recovered (hysteresis). */
  recover_samples: number;
}

export const DEFAULT_THRESHOLDS: HealthThresholds = {
  sample_interval_sec: 10,
  silence_db: -50,
  silence_duration_sec: 15,
  desync_ms: 200,
  stall_sec: 20,
  bitrate_drop_pct: 50,
  recover_samples: 2,
};

/** Inclusive [min, max] bounds per key (mirrors the configSchema bounds). */
export const THRESHOLD_BOUNDS: Record<keyof HealthThresholds, [number, number]> = {
  sample_interval_sec: [2, 300],
  silence_db: [-120, 0],
  silence_duration_sec: [1, 600],
  desync_ms: [10, 10000],
  stall_sec: [2, 600],
  bitrate_drop_pct: [0, 95],
  recover_samples: [1, 10],
};

/** Thrown on an invalid per-room override (controller maps it to a 400). */
export class HealthSettingsError extends Error {}

/**
 * Sanitize a PARTIAL per-room override: unknown keys are rejected (a typo
 * must not silently no-op), values must be finite numbers within bounds.
 * Returns a plain partial with only the overridden keys.
 */
export function sanitizeOverride(
  input: unknown,
): Partial<HealthThresholds> {
  if (input === null || input === undefined) return {};
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new HealthSettingsError('settings must be a JSON object');
  }
  const out: Partial<HealthThresholds> = {};
  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    const bounds = THRESHOLD_BOUNDS[key as keyof HealthThresholds];
    if (!bounds) {
      throw new HealthSettingsError(`unknown threshold '${key}'`);
    }
    const n = typeof raw === 'string' ? Number(raw) : raw;
    if (typeof n !== 'number' || !Number.isFinite(n)) {
      throw new HealthSettingsError(`threshold '${key}' must be a number`);
    }
    const [min, max] = bounds;
    if (n < min || n > max) {
      throw new HealthSettingsError(
        `threshold '${key}' must be between ${min} and ${max}`,
      );
    }
    out[key as keyof HealthThresholds] = n;
  }
  return out;
}

/**
 * Resolve the effective thresholds: defaults ⊕ app install config ⊕ per-room
 * override. Non-numeric / out-of-range values in the LOWER layers are ignored
 * (fall through to the default) rather than thrown — an old install config
 * must never break resolution.
 */
export function resolveThresholds(
  appConfig?: Record<string, unknown> | null,
  override?: Partial<HealthThresholds> | null,
): HealthThresholds {
  const out: HealthThresholds = { ...DEFAULT_THRESHOLDS };
  for (const layer of [appConfig ?? {}, override ?? {}]) {
    for (const key of Object.keys(THRESHOLD_BOUNDS) as (keyof HealthThresholds)[]) {
      const raw = (layer as Record<string, unknown>)[key];
      const n = typeof raw === 'string' ? Number(raw) : raw;
      if (typeof n !== 'number' || !Number.isFinite(n)) continue;
      const [min, max] = THRESHOLD_BOUNDS[key];
      if (n < min || n > max) continue;
      out[key] = n;
    }
  }
  return out;
}
