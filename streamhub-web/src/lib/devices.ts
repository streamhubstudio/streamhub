/**
 * Pure helpers of the Encoders (devices) tab — kept out of the .tsx so
 * node:test can cover them. Mirrors the core's rules in
 * streamhub-core-go/internal/devices (secrets.go NormalizeCode).
 */

/** The pairing-code alphabet (no 0/O/1/I/L), 8 symbols per code. */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
export const CODE_LENGTH = 8

/**
 * Normalizes what an operator typed: upper-case, separators dropped. Returns
 * null unless it is exactly 8 alphabet symbols (the core answers 404 anyway;
 * this only saves a round trip that would count as a failed attempt).
 */
export function normalizePairingCode(raw: string): string | null {
  const s = raw.toUpperCase().replace(/[\s\-._]/g, '')
  if (s.length !== CODE_LENGTH) return null
  for (const ch of s) if (!CODE_ALPHABET.includes(ch)) return null
  return s
}

/** Badge tone of a channel `state` reported by the device. */
export function channelStateTone(state: string | undefined): 'green' | 'red' | 'amber' | 'slate' {
  switch (state) {
    case 'live':
      return 'green'
    case 'error':
      return 'red'
    case 'starting':
    case 'reconnecting':
      return 'amber'
    default:
      return 'slate'
  }
}

/**
 * The channels the dashboard can link: the ones the device announced in
 * `hello.capabilities.channels`, plus any already linked (a device that has
 * not said hello yet still shows its links). Sorted by id, de-duplicated.
 */
export function linkableChannels(
  announced: { id: string; name?: string }[] | undefined,
  linked: { id: string; name?: string }[],
): { id: string; name?: string }[] {
  const byId = new Map<string, { id: string; name?: string }>()
  for (const c of announced ?? []) if (c && typeof c.id === 'string' && c.id) byId.set(c.id, c)
  for (const c of linked) if (!byId.has(c.id)) byId.set(c.id, c)
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
}
