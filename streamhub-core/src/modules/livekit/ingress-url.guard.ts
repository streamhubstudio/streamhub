/**
 * SSRF guard for the URL-pull ingress (`IngressInput.URL_INPUT`).
 *
 * A tenant-supplied pull URL makes the LiveKit ingress service FETCH it —
 * without validation that is a classic SSRF sink (e.g. pointing ingest at the
 * cloud metadata endpoint `http://169.254.169.254/` or an internal RFC1918
 * service). Every URL accepted by `POST /apps/:app/ingress` with
 * `inputType: 'url'` must pass this guard first:
 *
 *   1. it parses as a URL with an allowed media scheme
 *      (http/https/rtsp/rtsps/rtmp/rtmps/srt — never file:, gopher:, data:…);
 *   2. its host does not resolve to a private / loopback / link-local /
 *      metadata address (reuses the security module's ip-cidr primitives:
 *      127/8, 10/8, 172.16/12, 192.168/16, 169.254/16, ::1, fc00::/7,
 *      fe80::/10) nor to the unspecified address (0.0.0.0 / ::);
 *   3. non-literal hostnames are DNS-resolved and EVERY answer is checked.
 *
 * Failures are 400 BadRequest with a clear message. DNS rebinding after the
 * check is out of scope for this wave (the ingress fetch happens seconds
 * later from the same network position).
 */
import { BadRequestException } from '@nestjs/common';
import { lookup } from 'dns/promises';

import { isPrivateOrLoopbackIp, parseIp } from '../security/ip-cidr.util';

/** Schemes a pull ingress may use (WHATWG URL protocol strings, with colon). */
export const ALLOWED_PULL_SCHEMES: ReadonlySet<string> = new Set([
  'http:',
  'https:',
  'rtsp:',
  'rtsps:',
  'rtmp:',
  'rtmps:',
  'srt:',
]);

/** Resolver signature (injectable for tests — specs must never dial DNS). */
export type HostResolver = (hostname: string) => Promise<string[]>;

const defaultResolver: HostResolver = async (hostname) => {
  const answers = await lookup(hostname, { all: true, verbatim: true });
  return answers.map((a) => a.address);
};

/** True when the address is unusable as a public target (SSRF-relevant). */
function isForbiddenAddress(address: string): boolean {
  if (isPrivateOrLoopbackIp(address)) return true;
  // Unspecified addresses (0.0.0.0 / ::) bind-redirect to localhost.
  const parsed = parseIp(address);
  return parsed !== null && parsed.value === 0n;
}

/**
 * Parse + scheme-check a pull URL (the synchronous half of the guard).
 * Returns the parsed URL; throws 400 on malformed URLs or forbidden schemes.
 */
export function parsePullUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BadRequestException(`invalid ingress pull url: '${raw}'`);
  }
  if (!ALLOWED_PULL_SCHEMES.has(url.protocol)) {
    throw new BadRequestException(
      `ingress pull url scheme '${url.protocol.replace(/:$/, '')}' is not allowed ` +
        `(allowed: http, https, rtsp, rtsps, rtmp, rtmps, srt)`,
    );
  }
  if (!url.hostname) {
    throw new BadRequestException('ingress pull url has no host');
  }
  return url;
}

/**
 * Full SSRF guard: scheme + host validation. Throws BadRequest when the URL
 * is malformed, uses a forbidden scheme, or its host is / resolves to a
 * private, loopback, link-local, metadata or unspecified address.
 */
export async function assertSafePullUrl(
  raw: string,
  resolveHost: HostResolver = defaultResolver,
): Promise<void> {
  const url = parsePullUrl(raw);
  // URL.hostname wraps IPv6 literals in brackets — strip for parsing.
  const hostname = url.hostname.replace(/^\[|\]$/g, '');

  // IP literal: check directly, no DNS.
  if (parseIp(hostname)) {
    if (isForbiddenAddress(hostname)) {
      throw new BadRequestException(
        'ingress pull url points at a private/loopback/link-local address',
      );
    }
    return;
  }

  let addresses: string[];
  try {
    addresses = await resolveHost(hostname);
  } catch {
    throw new BadRequestException(
      `ingress pull url host '${hostname}' does not resolve`,
    );
  }
  if (!addresses.length) {
    throw new BadRequestException(
      `ingress pull url host '${hostname}' does not resolve`,
    );
  }
  if (addresses.some((a) => isForbiddenAddress(a))) {
    throw new BadRequestException(
      'ingress pull url resolves to a private/loopback/link-local address',
    );
  }
}
