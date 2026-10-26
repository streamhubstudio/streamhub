/**
 * Pure hour-bucket math for the net-metrics store (Wave 1C). One `net_samples`
 * row is keyed by an UTC hour bucket `YYYY-MM-DDTHH` — coarse enough that a
 * 60 s flush interval never fragments the table, fine enough for a 48 h
 * dashboard sparkline. No I/O, no Date mutation — trivially unit-testable and
 * shared verbatim by the collector, the threshold monitor and the controller.
 */

/** Bytes in one gigabyte. Binary (GiB) so the threshold compares apples-to-apples
 *  with the dashboard's `formatBytes` (which also uses 1024-based units). */
export const GB_BYTES = 1024 ** 3;

/** Milliseconds in one hour. */
export const HOUR_MS = 3_600_000;

/**
 * UTC hour bucket for an instant, `YYYY-MM-DDTHH` (e.g. `2026-07-11T14`).
 * Accepts a Date or epoch-ms; defaults to now.
 */
export function hourBucket(at: Date | number = Date.now()): string {
  const d = at instanceof Date ? at : new Date(at);
  return d.toISOString().slice(0, 13);
}

/**
 * The hour bucket `hours` before `now` — the lower bound for a rolling-window
 * `WHERE bucket >= ?` query (inclusive of the boundary hour). Fractional hours
 * are allowed (rounded down to the containing hour bucket).
 */
export function windowStartBucket(
  now: number = Date.now(),
  hours = 24,
): string {
  return hourBucket(now - Math.max(0, hours) * HOUR_MS);
}

/** Convert a gigabyte-per-day threshold to bytes (0/negative/NaN → 0). */
export function gbToBytes(gb: number | undefined | null): number {
  if (gb == null || !Number.isFinite(gb) || gb <= 0) return 0;
  return gb * GB_BYTES;
}
