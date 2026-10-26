/**
 * Shared datetime formatting — the ONE place a timestamp gets turned into
 * text for a human.
 *
 * Before this existed, the same job was done three different ways scattered
 * across the dashboard: raw ISO strings rendered straight from the wire
 * (e.g. Logs showed `2026-07-13T12:45:00.879Z` verbatim), `toLocaleString()`
 * (locale- and browser-dependent — two admins on two machines could see two
 * different formats for the same instant), and several hand-rolled copies of
 * the same `Number.isNaN(d.getTime()) ? iso : ...` guard. All of that funnels
 * through `formatDateTime` now, rendered as a stable, readable SQL-style
 * `YYYY-MM-DD HH:mm:ss`.
 *
 * Owner item 11 (per-app timezone): `formatDateTime` takes an OPTIONAL IANA
 * `timeZone` as its 2nd argument. Omitted/empty → unchanged pre-existing
 * behaviour, the browser's LOCAL time zone (matches the operator's wall
 * clock, never UTC) — this is what every NON-app screen keeps using. App-
 * scoped screens (logs/streams/VODs/backups…) pass the app's configured
 * timezone (see `pages/AppDetail/AppTimezoneContext.tsx`'s `useAppTimezone()`)
 * so every operator sees the SAME wall-clock for that app's events, regardless
 * of which browser/machine/local timezone they're viewing from.
 *
 * Pure (no React) so it's unit-testable under node:test.
 */

const DASH = '—'

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/**
 * Render `d` as `YYYY-MM-DD HH:mm:ss` in the given IANA `timeZone`, or `null`
 * if the zone is empty/unrecognized (caller falls back to local time).
 */
function formatInTimeZone(d: Date, timeZone: string): string | null {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(d)
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
    // Some engines render midnight as "24" under hour12:false — normalize.
    const hour = get('hour') === '24' ? '00' : get('hour')
    const year = get('year')
    const month = get('month')
    const day = get('day')
    const minute = get('minute')
    const second = get('second')
    if (!year || !month || !day) return null
    return `${year}-${month}-${day} ${hour}:${minute}:${second}`
  } catch {
    return null // unrecognized IANA zone — caller falls back to local time
  }
}

/**
 * Format an ISO/SQLite datetime string, epoch millis, or a `Date` as
 * `YYYY-MM-DD HH:mm:ss`, optionally in a given IANA `timeZone` (empty/omitted
 * = the browser's local time zone, the pre-existing default behaviour).
 *
 * Missing/empty input → em dash. Input that doesn't parse into a valid date
 * is returned verbatim, so a malformed wire value stays visible instead of
 * being silently swallowed. An unrecognized `timeZone` degrades to local time
 * rather than throwing.
 */
export function formatDateTime(
  input?: string | number | Date | null,
  timeZone?: string | null,
): string {
  if (input === null || input === undefined || input === '') return DASH
  const d = input instanceof Date ? input : new Date(input)
  if (Number.isNaN(d.getTime())) return String(input)
  if (timeZone) {
    const formatted = formatInTimeZone(d, timeZone)
    if (formatted) return formatted
  }
  const y = d.getFullYear()
  const mo = pad(d.getMonth() + 1)
  const day = pad(d.getDate())
  const h = pad(d.getHours())
  const mi = pad(d.getMinutes())
  const s = pad(d.getSeconds())
  return `${y}-${mo}-${day} ${h}:${mi}:${s}`
}

/** Small, curated set used only when `Intl.supportedValuesOf` is unavailable. */
export const FALLBACK_TIMEZONES: readonly string[] = [
  'UTC',
  'America/Argentina/Buenos_Aires',
  'America/Sao_Paulo',
  'America/Bogota',
  'America/Lima',
  'America/Santiago',
  'America/Mexico_City',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Anchorage',
  'Europe/London',
  'Europe/Madrid',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Rome',
  'Europe/Lisbon',
  'Europe/Moscow',
  'Africa/Cairo',
  'Africa/Johannesburg',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Bangkok',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Asia/Seoul',
  'Asia/Singapore',
  'Australia/Sydney',
  'Australia/Perth',
  'Pacific/Auckland',
]

let cachedZones: string[] | null = null

/**
 * Every IANA timezone name the browser knows about (memoized), sorted. Falls
 * back to a small curated list on an older browser without
 * `Intl.supportedValuesOf` — used to populate the Config tab's timezone
 * selector (see `pages/AppDetail/ConfigTab.tsx`).
 */
export function listTimezones(): string[] {
  if (cachedZones) return cachedZones
  try {
    const values = Intl.supportedValuesOf?.('timeZone')
    cachedZones = Array.isArray(values) && values.length ? values : [...FALLBACK_TIMEZONES]
  } catch {
    cachedZones = [...FALLBACK_TIMEZONES]
  }
  if (!cachedZones.includes('UTC')) cachedZones.push('UTC')
  return [...cachedZones].sort()
}

/**
 * Whether `tz` is a real IANA timezone name. Empty string is always valid
 * (means "server default" — no per-app override).
 */
export function isValidTimezone(tz: string): boolean {
  if (tz === '') return true
  if (listTimezones().includes(tz)) return true
  try {
    void new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}
