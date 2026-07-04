/**
 * Pure IPv4/IPv6 + CIDR helpers for the security module (no Node deps).
 *
 * Both address families are normalised to a BigInt so a single prefix compare
 * covers `10.0.0.0/8` and `2001:db8::/32` alike. IPv4-mapped IPv6 addresses
 * (`::ffff:1.2.3.4`) are folded to plain IPv4 first, so a v4 rule matches a
 * client that arrived over a dual-stack socket.
 *
 * These helpers are deliberately side-effect free: the middleware calls them on
 * EVERY request, and the specs exercise them without any Nest/DB context.
 */
import type { Request } from 'express';

export type IpVersion = 4 | 6;

export interface ParsedIp {
  version: IpVersion;
  /** Address as an unsigned BigInt (32 bits for v4, 128 for v6). */
  value: bigint;
}

export interface ParsedCidr {
  version: IpVersion;
  /** Network address (host bits already zeroed). */
  network: bigint;
  /** Prefix length (0..32 v4, 0..128 v6). */
  prefix: number;
  /** Canonical `<ip>/<prefix>` string (as the operator entered the IP part). */
  cidr: string;
}

/** Strip an IPv4-mapped IPv6 prefix and any zone index (`%eth0`). */
export function normalizeIp(raw: string): string {
  let ip = (raw || '').trim();
  const zone = ip.indexOf('%');
  if (zone !== -1) ip = ip.slice(0, zone);
  if (ip.toLowerCase().startsWith('::ffff:') && ip.includes('.')) {
    ip = ip.slice(7);
  }
  return ip;
}

function parseIpv4(ip: string): bigint | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value << 8n) | BigInt(octet);
  }
  return value;
}

function parseIpv6(ip: string): bigint | null {
  if (!ip.includes(':')) return null;
  // Embedded IPv4 tail (e.g. `::ffff:1.2.3.4` after zone stripping missed it).
  let tail: number[] | null = null;
  let head = ip;
  const lastColon = ip.lastIndexOf(':');
  if (ip.includes('.')) {
    const v4 = parseIpv4(ip.slice(lastColon + 1));
    if (v4 === null) return null;
    tail = [Number((v4 >> 16n) & 0xffffn), Number(v4 & 0xffffn)];
    head = ip.slice(0, lastColon);
    if (head.endsWith(':') && !head.endsWith('::')) head = head.slice(0, -1);
  }

  const groupsNeeded = 8 - (tail ? 2 : 0);
  const doubleColons = head.split('::').length - 1;
  if (doubleColons > 1) return null;

  let groups: string[];
  if (doubleColons === 1) {
    const [left, right] = head.split('::');
    const leftGroups = left === '' ? [] : left.split(':');
    const rightGroups = right === '' ? [] : right.split(':');
    const fill = groupsNeeded - leftGroups.length - rightGroups.length;
    if (fill < 0) return null;
    groups = [...leftGroups, ...Array<string>(fill).fill('0'), ...rightGroups];
  } else {
    groups = head === '' ? [] : head.split(':');
  }
  if (groups.length !== groupsNeeded) return null;

  let value = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    value = (value << 16n) | BigInt(parseInt(g, 16));
  }
  if (tail) {
    for (const t of tail) value = (value << 16n) | BigInt(t);
  }
  return value;
}

/** Parse a bare IP (v4 or v6). Returns null when it is not a valid address. */
export function parseIp(raw: string): ParsedIp | null {
  const ip = normalizeIp(raw);
  if (!ip) return null;
  if (ip.includes(':')) {
    const value = parseIpv6(ip);
    return value === null ? null : { version: 6, value };
  }
  const value = parseIpv4(ip);
  return value === null ? null : { version: 4, value };
}

/**
 * Parse `a.b.c.d/n`, `<v6>/n` or a bare IP (implied /32 or /128). Host bits are
 * zeroed so `10.0.0.5/8` compiles to network `10.0.0.0/8`. Null when invalid.
 */
export function parseCidr(raw: string): ParsedCidr | null {
  const entry = (raw || '').trim();
  if (!entry) return null;
  const slash = entry.indexOf('/');
  const ipPart = slash === -1 ? entry : entry.slice(0, slash);
  const parsed = parseIp(ipPart);
  if (!parsed) return null;

  const bits = parsed.version === 4 ? 32 : 128;
  let prefix = bits;
  if (slash !== -1) {
    const prefixPart = entry.slice(slash + 1);
    if (!/^\d{1,3}$/.test(prefixPart)) return null;
    prefix = Number(prefixPart);
    if (prefix < 0 || prefix > bits) return null;
  }

  const hostBits = BigInt(bits - prefix);
  const network = prefix === 0 ? 0n : (parsed.value >> hostBits) << hostBits;
  return {
    version: parsed.version,
    network,
    prefix,
    cidr: `${normalizeIp(ipPart)}/${prefix}`,
  };
}

/** True when `ip` (already parsed) falls inside the compiled CIDR. */
export function ipInCidr(ip: ParsedIp, cidr: ParsedCidr): boolean {
  if (ip.version !== cidr.version) return false;
  const bits = cidr.version === 4 ? 32 : 128;
  if (cidr.prefix === 0) return true;
  const hostBits = BigInt(bits - cidr.prefix);
  return (ip.value >> hostBits) << hostBits === cidr.network;
}

/** String-in, compiled per call — convenience for one-off checks/tests. */
export function ipMatchesCidr(ip: string, cidr: string): boolean {
  const parsedIp = parseIp(ip);
  const parsedCidr = parseCidr(cidr);
  if (!parsedIp || !parsedCidr) return false;
  return ipInCidr(parsedIp, parsedCidr);
}

/**
 * Ranges that are ALWAYS permitted and NEVER auto-banned — the lock-out
 * guarantee: loopback, RFC1918, link-local and the IPv6 ULA/link-local
 * equivalents. The box itself, Docker networks and LAN/cluster peers all fall
 * in here, so no rule/ban combination can cut off local access.
 */
const PRIVATE_CIDRS: ParsedCidr[] = [
  '127.0.0.0/8', // v4 loopback
  '10.0.0.0/8', // RFC1918
  '172.16.0.0/12', // RFC1918
  '192.168.0.0/16', // RFC1918
  '169.254.0.0/16', // v4 link-local
  '::1/128', // v6 loopback
  'fc00::/7', // v6 ULA
  'fe80::/10', // v6 link-local
].map((c) => parseCidr(c) as ParsedCidr);

/** True for loopback / RFC1918 / link-local / ULA (see PRIVATE_CIDRS). */
export function isPrivateOrLoopbackIp(raw: string): boolean {
  const ip = parseIp(raw);
  if (!ip) return false;
  return PRIVATE_CIDRS.some((c) => ipInCidr(ip, c));
}

/**
 * Real client IP for a request behind the reverse proxy: first hop of
 * X-Forwarded-For (Caddy/nginx append the peer address), falling back to the
 * socket. Same resolution the session/auth code uses.
 */
export function clientIpOf(req: Request): string | null {
  const fwd = req.headers['x-forwarded-for'];
  let ip = '';
  if (typeof fwd === 'string' && fwd.length > 0) ip = fwd.split(',')[0].trim();
  else if (Array.isArray(fwd) && fwd.length > 0) ip = fwd[0].trim();
  else ip = req.ip || req.socket?.remoteAddress || '';
  const normalized = normalizeIp(ip);
  return normalized || null;
}
