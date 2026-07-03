/**
 * Relative-time bucketing — pure and i18n-agnostic.
 *
 * Returns a `{ unit, count }` pair (never a formatted string) so the caller can
 * localise it with i18next plurals (clusterPage:relative.<unit>). Used for a
 * node's `last_seen_at`. `now` is injectable to keep the logic deterministic in
 * tests.
 */

export type RelativeUnit = 'now' | 'seconds' | 'minutes' | 'hours' | 'days'

export interface RelativeTime {
  unit: RelativeUnit
  count: number
  /** True when the input was missing/unparseable — caller shows a placeholder. */
  invalid: boolean
}

const MINUTE = 60
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * Bucket the elapsed time between `iso` and `now` into now/seconds/minutes/
 * hours/days. Future timestamps clamp to `now` (count 0). Anything under 10s
 * reads as "now".
 */
export function relativeTime(
  iso: string | number | Date | null | undefined,
  now: number = Date.now(),
): RelativeTime {
  if (iso === null || iso === undefined || iso === '') {
    return { unit: 'now', count: 0, invalid: true }
  }
  const then = iso instanceof Date ? iso.getTime() : new Date(iso).getTime()
  if (Number.isNaN(then)) {
    return { unit: 'now', count: 0, invalid: true }
  }

  const elapsedS = Math.max(0, Math.floor((now - then) / 1000))

  if (elapsedS < 10) return { unit: 'now', count: 0, invalid: false }
  if (elapsedS < MINUTE) return { unit: 'seconds', count: elapsedS, invalid: false }
  if (elapsedS < HOUR)
    return { unit: 'minutes', count: Math.floor(elapsedS / MINUTE), invalid: false }
  if (elapsedS < DAY)
    return { unit: 'hours', count: Math.floor(elapsedS / HOUR), invalid: false }
  return { unit: 'days', count: Math.floor(elapsedS / DAY), invalid: false }
}
