/**
 * Pure CIDR/IP validation for the Network-security rule form (mirrors the
 * backend's ip-cidr.util parser: IPv4 + IPv6, bare IPs implied /32 // /128).
 * Kept UI-free so it runs under node:test.
 */

function isValidIpv4(ip: string): boolean {
  const parts = ip.split('.')
  if (parts.length !== 4) return false
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
}

function isValidIpv6(ip: string): boolean {
  if (!ip.includes(':')) return false
  let head = ip
  let groupsNeeded = 8
  // Embedded IPv4 tail (::ffff:1.2.3.4)
  if (ip.includes('.')) {
    const lastColon = ip.lastIndexOf(':')
    if (!isValidIpv4(ip.slice(lastColon + 1))) return false
    head = ip.slice(0, lastColon)
    if (head.endsWith(':') && !head.endsWith('::')) head = head.slice(0, -1)
    groupsNeeded = 6
  }
  const doubles = head.split('::').length - 1
  if (doubles > 1) return false
  const groupOk = (g: string) => /^[0-9a-fA-F]{1,4}$/.test(g)
  if (doubles === 1) {
    const [left, right] = head.split('::')
    const lg = left === '' ? [] : left.split(':')
    const rg = right === '' ? [] : right.split(':')
    if (lg.length + rg.length > groupsNeeded) return false
    return [...lg, ...rg].every(groupOk)
  }
  const groups = head === '' ? [] : head.split(':')
  return groups.length === groupsNeeded && groups.every(groupOk)
}

/** Strip an IPv4-mapped prefix + zone index, trim whitespace. */
export function normalizeIp(raw: string): string {
  let ip = (raw || '').trim()
  const zone = ip.indexOf('%')
  if (zone !== -1) ip = ip.slice(0, zone)
  if (ip.toLowerCase().startsWith('::ffff:') && ip.includes('.')) ip = ip.slice(7)
  return ip
}

/**
 * True for a valid IPv4/IPv6 CIDR (`a.b.c.d/nn`, `2001:db8::/32`) or a bare
 * IP (implied /32 or /128) — exactly what POST /security/ip-rules accepts.
 */
export function isValidCidr(raw: string): boolean {
  const entry = (raw || '').trim()
  if (!entry) return false
  const slash = entry.indexOf('/')
  const ipPart = normalizeIp(slash === -1 ? entry : entry.slice(0, slash))
  const v4 = isValidIpv4(ipPart)
  const v6 = !v4 && isValidIpv6(ipPart)
  if (!v4 && !v6) return false
  if (slash === -1) return true
  const prefixPart = entry.slice(slash + 1)
  if (!/^\d{1,3}$/.test(prefixPart)) return false
  const prefix = Number(prefixPart)
  return prefix >= 0 && prefix <= (v4 ? 32 : 128)
}
