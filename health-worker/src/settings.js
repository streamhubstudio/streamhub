/**
 * Threshold resolution on the WORKER side — MUST mirror
 * streamhub-core/src/modules/stream-health/stream-health.thresholds.ts
 * (same keys, same defaults, same bounds, same layering). Both sides are
 * locked by unit tests against the same values.
 *
 * Layers, later wins:
 *   1. DEFAULTS below;
 *   2. the app-level install config (HEALTH_CONFIG_JSON in the worker env);
 *   3. the per-room override, read READ-ONLY from the app's
 *      stream-health.db each cycle (node:sqlite) — so a PUT
 *      …/streams/:room/settings takes effect live, no restart.
 */

export const DEFAULTS = Object.freeze({
  sample_interval_sec: 10,
  silence_db: -50,
  silence_duration_sec: 15,
  desync_ms: 200,
  stall_sec: 20,
  bitrate_drop_pct: 50,
  recover_samples: 2,
});

export const BOUNDS = Object.freeze({
  sample_interval_sec: [2, 300],
  silence_db: [-120, 0],
  silence_duration_sec: [1, 600],
  desync_ms: [10, 10000],
  stall_sec: [2, 600],
  bitrate_drop_pct: [0, 95],
  recover_samples: [1, 10],
});

/**
 * defaults ⊕ appConfig ⊕ override — invalid / out-of-range values in any
 * layer fall through silently (a stale config must never crash the probe).
 */
export function resolveThresholds(appConfig, override) {
  const out = { ...DEFAULTS };
  for (const layer of [appConfig ?? {}, override ?? {}]) {
    for (const key of Object.keys(BOUNDS)) {
      const raw = layer[key];
      const n = typeof raw === 'string' ? Number(raw) : raw;
      if (typeof n !== 'number' || !Number.isFinite(n)) continue;
      const [min, max] = BOUNDS[key];
      if (n < min || n > max) continue;
      out[key] = n;
    }
  }
  return out;
}

/** Parse HEALTH_CONFIG_JSON (the app-level layer); {} on any trouble. */
export function parseAppConfig(json) {
  try {
    const parsed = JSON.parse(json ?? '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    /* fall through */
  }
  return {};
}

/**
 * Read every per-room override from stream-health.db (read-only). Returns a
 * Map room → partial override. Any trouble (db missing — the core simply has
 * not created it yet — node:sqlite unavailable, table absent) → empty Map.
 * A fresh open per cycle keeps WAL reads current and holds no lock.
 */
export async function readRoomOverrides(dbFile) {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbFile, { readOnly: true });
    try {
      const rows = db
        .prepare('SELECT room, config_json FROM stream_settings')
        .all();
      const map = new Map();
      for (const row of rows) {
        try {
          const parsed = JSON.parse(String(row.config_json ?? '{}'));
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            map.set(String(row.room), parsed);
          }
        } catch {
          /* skip corrupt row */
        }
      }
      return map;
    } finally {
      db.close();
    }
  } catch {
    return new Map();
  }
}
