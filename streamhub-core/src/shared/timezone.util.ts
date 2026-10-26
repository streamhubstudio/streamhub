/**
 * Per-app IANA timezone validation (owner item 11).
 *
 * The single source of truth for "is this a real IANA timezone name" on the
 * server side. Primary check is `Intl.supportedValuesOf('timeZone')` (Node
 * >= 18); a small curated fallback list covers the (unlikely) case where the
 * runtime's ICU build doesn't expose `supportedValuesOf` at all. Empty string
 * is always valid — it means "server/host local time" (the pre-existing
 * default behaviour), never a real zone.
 *
 * `tsconfig.json` targets ES2021 with no `lib` override, so the `Intl`
 * type doesn't declare `supportedValuesOf` (that's ES2022) — hence the
 * `as unknown as {...}` cast below. The runtime call is still guarded by
 * try/catch, so an older Node without the method degrades to the fallback
 * list instead of throwing.
 */

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
];

let cachedZones: Set<string> | null = null;

/** Every IANA zone name the runtime knows about (memoized). */
function supportedZones(): Set<string> {
  if (cachedZones) return cachedZones;
  try {
    const fn = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] })
      .supportedValuesOf;
    const values = typeof fn === 'function' ? fn('timeZone') : undefined;
    cachedZones = new Set(
      Array.isArray(values) && values.length ? values : FALLBACK_TIMEZONES,
    );
  } catch {
    cachedZones = new Set(FALLBACK_TIMEZONES);
  }
  // `UTC` is the universal fallback used throughout the app (e.g.
  // scheduled-live's default) but some ICU builds omit it (and the whole
  // `Etc/*` group) from `supportedValuesOf('timeZone')` — always guarantee
  // it's listed, even though `isValidTimezone` already accepts it either way
  // via the Intl.DateTimeFormat safety net below.
  cachedZones.add('UTC');
  return cachedZones;
}

/** Sorted list of every IANA zone name known to this runtime (or the fallback). */
export function listTimezones(): string[] {
  return Array.from(supportedZones()).sort();
}

/**
 * Whether `tz` is a real IANA timezone name. Empty string is always valid
 * (means "server/host local time" — no per-app override).
 */
export function isValidTimezone(tz: string): boolean {
  if (tz === '') return true;
  if (supportedZones().has(tz)) return true;
  // Safety net: a zone the ICU build actually supports but our snapshot/
  // fallback list happens to miss — Intl.DateTimeFormat throws RangeError on
  // a truly unknown zone, so a successful construction means it's real.
  try {
    void new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
