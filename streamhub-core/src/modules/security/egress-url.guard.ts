/**
 * Generic SSRF guard for server-side EGRESS dials (security fix P0-1,
 * OWASP A01/A06 — see https://streamhub.studio/docs/security/FIX-BACKLOG).
 *
 * Tenants can point several outbound sinks at arbitrary URLs: the per-app
 * webhook/callback URL, a custom S3 endpoint (MinIO/Wasabi) and the per-app
 * MQTT broker. Without validation each one is an SSRF primitive (e.g. POSTing
 * signed payloads at the cloud metadata endpoint `http://169.254.169.254/` or
 * probing internal RFC1918 services from the server's network position).
 *
 * Same contract as the URL-pull ingress guard (`modules/livekit/
 * ingress-url.guard.ts`), generalized for any sink:
 *
 *   1. the value parses as a URL with a scheme in the sink's allowlist
 *      (never file:, gopher:, data:…);
 *   2. its host is not / does not resolve to a private, loopback, link-local,
 *      metadata or unspecified address (reuses the security module's ip-cidr
 *      primitives: 127/8, 10/8, 172.16/12, 192.168/16, 169.254/16, ::1,
 *      fc00::/7, fe80::/10, plus 0.0.0.0 / ::);
 *   3. non-literal hostnames are DNS-resolved and EVERY answer is checked.
 *
 * Escape hatches (all default DENY-private):
 *   - `allowPrivate` — skips the private-address check entirely (scheme
 *     allowlist still applies). Wired to `STREAMHUB_ALLOW_PRIVATE_S3_ENDPOINT`
 *     / `STREAMHUB_ALLOW_PRIVATE_MQTT_BROKER` for self-hosted MinIO / on-prem
 *     brokers.
 *   - `allowlist` — operator-managed list of exact hostnames and/or IP/CIDR
 *     entries exempted from the private check. Wired to
 *     `STREAMHUB_CALLBACK_ALLOW_HOSTS` (default empty).
 *
 * Failures throw 400 BadRequest with a clear, sink-labelled message. DNS
 * rebinding after the check is out of scope for this wave (same stance as the
 * ingress guard).
 */
import { BadRequestException } from '@nestjs/common';
import { lookup } from 'dns/promises';

import {
  ipInCidr,
  isPrivateOrLoopbackIp,
  parseCidr,
  parseIp,
  type ParsedCidr,
} from './ip-cidr.util';

// ---------------------------------------------------------------------------
// Env knobs (read by the sink call sites; constants here so they stay in sync
// with .env.example / https://streamhub.studio/docs/operations/ENV)
// ---------------------------------------------------------------------------

/** Comma-separated hostnames / IPs / CIDRs allowed as PRIVATE callback targets. */
export const CALLBACK_ALLOW_HOSTS_ENV = 'STREAMHUB_CALLBACK_ALLOW_HOSTS';
/** '1' → allow a private/loopback custom S3 endpoint (self-hosted MinIO). */
export const ALLOW_PRIVATE_S3_ENDPOINT_ENV = 'STREAMHUB_ALLOW_PRIVATE_S3_ENDPOINT';
/** '1' → allow a private/loopback MQTT broker URL (on-prem broker). */
export const ALLOW_PRIVATE_MQTT_BROKER_ENV = 'STREAMHUB_ALLOW_PRIVATE_MQTT_BROKER';

/** Schemes a webhook/callback or S3 endpoint may use. */
export const HTTP_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:']);

/** Schemes an MQTT broker URL may use (mqtt.js accepted transports). */
export const MQTT_SCHEMES: ReadonlySet<string> = new Set([
  'mqtt:',
  'mqtts:',
  'ws:',
  'wss:',
  'tcp:',
  'tls:',
]);

/** Truthy env flag: '1' / 'true' / 'yes' / 'on' (case-insensitive). */
export function envFlag(raw: string | undefined): boolean {
  const v = (raw || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/** Parse a comma-separated env allowlist into trimmed non-empty entries. */
export function parseAllowlistEnv(raw: string | undefined): string[] {
  return (raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// ---------------------------------------------------------------------------
// Guard
// ---------------------------------------------------------------------------

/** Resolver signature (injectable for tests — specs must never dial DNS). */
export type HostResolver = (hostname: string) => Promise<string[]>;

export const defaultHostResolver: HostResolver = async (hostname) => {
  const answers = await lookup(hostname, { all: true, verbatim: true });
  return answers.map((a) => a.address);
};

export interface EgressGuardOptions {
  /** Allowed WHATWG URL protocol strings, with the trailing colon. */
  allowedSchemes: ReadonlySet<string>;
  /** Sink label for error messages, e.g. 'callback URL' / 'S3 endpoint'. */
  label: string;
  /** Env escape: skip the private-address check (scheme check still runs). */
  allowPrivate?: boolean;
  /** Hostname / IP / CIDR entries exempted from the private check. */
  allowlist?: readonly string[];
  /** DNS seam; defaults to dns.lookup. Tests MUST inject a fake. */
  resolveHost?: HostResolver;
}

/** True when the address is unusable as a public egress target. */
export function isForbiddenEgressAddress(address: string): boolean {
  if (isPrivateOrLoopbackIp(address)) return true;
  // Unspecified addresses (0.0.0.0 / ::) bind-redirect to localhost.
  const parsed = parseIp(address);
  return parsed !== null && parsed.value === 0n;
}

interface CompiledAllowlist {
  hostnames: Set<string>;
  cidrs: ParsedCidr[];
}

function compileAllowlist(entries: readonly string[] = []): CompiledAllowlist {
  const hostnames = new Set<string>();
  const cidrs: ParsedCidr[] = [];
  for (const entry of entries) {
    const cidr = parseCidr(entry);
    if (cidr) cidrs.push(cidr);
    else hostnames.add(entry.toLowerCase());
  }
  return { hostnames, cidrs };
}

function addressInAllowlist(address: string, allow: CompiledAllowlist): boolean {
  const ip = parseIp(address);
  if (!ip) return false;
  return allow.cidrs.some((c) => ipInCidr(ip, c));
}

/**
 * Parse + scheme-check an egress URL (the synchronous half of the guard).
 * Returns the parsed URL; throws 400 on malformed URLs or forbidden schemes.
 */
export function parseEgressUrl(
  raw: string,
  opts: Pick<EgressGuardOptions, 'allowedSchemes' | 'label'>,
): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BadRequestException(`invalid ${opts.label}: '${raw}'`);
  }
  if (!opts.allowedSchemes.has(url.protocol)) {
    const allowed = [...opts.allowedSchemes]
      .map((s) => s.replace(/:$/, ''))
      .join(', ');
    throw new BadRequestException(
      `${opts.label} scheme '${url.protocol.replace(/:$/, '')}' is not allowed ` +
        `(allowed: ${allowed})`,
    );
  }
  if (!url.hostname) {
    throw new BadRequestException(`${opts.label} has no host`);
  }
  return url;
}

/**
 * Synchronous guard: scheme allowlist + IP-LITERAL host check only (no DNS).
 * For sinks whose creation path is synchronous (the MQTT client factory) —
 * the async {@link assertSafeEgressUrl} at the config layer remains the
 * authoritative check for hostnames.
 */
export function assertSafeEgressUrlSync(
  raw: string,
  opts: Omit<EgressGuardOptions, 'resolveHost'>,
): void {
  const url = parseEgressUrl(raw, opts);
  if (opts.allowPrivate) return;
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const allow = compileAllowlist(opts.allowlist);
  if (allow.hostnames.has(hostname.toLowerCase())) return;
  if (parseIp(hostname)) {
    if (addressInAllowlist(hostname, allow)) return;
    if (isForbiddenEgressAddress(hostname)) {
      throw new BadRequestException(
        `${opts.label} points at a private/loopback/link-local address`,
      );
    }
  }
}

/**
 * Full SSRF guard: scheme + host validation, resolving hostnames and checking
 * EVERY DNS answer (partial-poison defence). Throws BadRequest when the URL is
 * malformed, uses a forbidden scheme, or its host is / resolves to a private,
 * loopback, link-local, metadata or unspecified address (unless exempted by
 * `allowPrivate` or the `allowlist`).
 */
export async function assertSafeEgressUrl(
  raw: string,
  opts: EgressGuardOptions,
): Promise<void> {
  const url = parseEgressUrl(raw, opts);
  if (opts.allowPrivate) return;

  // URL.hostname wraps IPv6 literals in brackets — strip for parsing.
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const allow = compileAllowlist(opts.allowlist);
  if (allow.hostnames.has(hostname.toLowerCase())) return;

  // IP literal: check directly, no DNS.
  if (parseIp(hostname)) {
    if (addressInAllowlist(hostname, allow)) return;
    if (isForbiddenEgressAddress(hostname)) {
      throw new BadRequestException(
        `${opts.label} points at a private/loopback/link-local address`,
      );
    }
    return;
  }

  const resolveHost = opts.resolveHost ?? defaultHostResolver;
  let addresses: string[];
  try {
    addresses = await resolveHost(hostname);
  } catch {
    throw new BadRequestException(
      `${opts.label} host '${hostname}' does not resolve`,
    );
  }
  if (!addresses.length) {
    throw new BadRequestException(
      `${opts.label} host '${hostname}' does not resolve`,
    );
  }
  const offending = addresses.some(
    (a) => isForbiddenEgressAddress(a) && !addressInAllowlist(a, allow),
  );
  if (offending) {
    throw new BadRequestException(
      `${opts.label} resolves to a private/loopback/link-local address`,
    );
  }
}
