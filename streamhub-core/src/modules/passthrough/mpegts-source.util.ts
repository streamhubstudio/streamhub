/**
 * Pure parse / validate / canonicalize for MPEG-TS-over-UDP passthrough ingest
 * sources (features/mpegts-multicast.md). No DI, no side effects — so the exact
 * ffmpeg input URL (incl. SSM `sources=`, `localaddr=`, `fifo_size=`,
 * `overrun_nonfatal=`) and every validation edge case can be pinned under jest.
 *
 * WHY A CANONICAL BUILDER: an MPEG-TS ingress is a PULL source — the remux
 * connects OUT to a multicast group / unicast port with
 * `ffmpeg -f mpegts -i udp://@GROUP:PORT?…`. The operator supplies a `udp://`
 * source (plus optional structured SSM/interface/buffer fields); we NEVER pass
 * their string to ffmpeg verbatim. Instead we parse it, allow-list + validate
 * every component (multicast range 224.0.0.0/4, port range, IPv4 source lists),
 * and REBUILD a deterministic URL. Unknown query keys are rejected, so nothing
 * an operator types can inject an arbitrary ffmpeg protocol option.
 *
 * FFMPEG SEMANTICS (verified against ffmpeg-protocols "udp" + libavformat/udp.c):
 *  - `udp://@HOST:PORT` — the leading `@` is ffmpeg's receive/bind convention
 *    (an empty userinfo delimiter): the socket BINDS locally and, when HOST is a
 *    class-D group, JOINS that multicast group. `udp://@:PORT` binds INADDR_ANY
 *    (unicast receive on every interface).
 *  - `sources=a,b` — IGMPv3 source-specific multicast (SSM): only receive/join
 *    traffic from these source IPs (`IP_ADD_SOURCE_MEMBERSHIP`).
 *  - `block=a,b`   — exclude these source IPs from the subscription.
 *  - `localaddr=IP` — local interface (by IP) used to send packets / join the
 *    group; the seam for NIC selection on multi-homed hosts.
 *  - `fifo_size=N` — UDP receiving circular buffer size, in units of 188-byte
 *    packets (ffmpeg default 7*4096 = 28672 ≈ 5.4 MB). Raise it for bursty /
 *    high-bitrate multicast.
 *  - `overrun_nonfatal=1` — survive a circular-buffer overrun instead of aborting
 *    (ffmpeg default 0). StreamHub defaults it ON so a transient burst on a live
 *    channel drops packets rather than killing the remux.
 */

/** IPv4 multicast range is 224.0.0.0/4 → first octet 224..239. */
export const MPEGTS_MULTICAST_MIN_OCTET = 224;
export const MPEGTS_MULTICAST_MAX_OCTET = 239;
/** `overrun_nonfatal` default: survive a buffer overrun rather than abort. */
export const MPEGTS_DEFAULT_OVERRUN_NONFATAL = true;
/** Cap on SSM `sources=` / `block=` list length (defensive). */
export const MPEGTS_MAX_SOURCE_IPS = 16;
/** `fifo_size=` bounds (units of 188-byte packets). */
export const MPEGTS_MIN_FIFO_SIZE = 1;
export const MPEGTS_MAX_FIFO_SIZE = 100_000_000;
/** Query keys we accept in the operator-supplied udp:// source (allow-list). */
const ALLOWED_QUERY_KEYS = new Set([
  'sources',
  'block',
  'localaddr',
  'fifo_size',
  'overrun_nonfatal',
]);

/** Structured MPEG-TS source options (from the create DTO + the udp:// url). */
export interface MpegtsSourceOptions {
  /** The udp:// source URL, e.g. `udp://@239.1.1.1:5000`. Query params tolerated + merged. */
  url: string;
  /** SSM include-list (IGMPv3): comma-separated or array of source IPs. */
  sources?: string | string[];
  /** SSM exclude-list: comma-separated or array of source IPs. */
  block?: string | string[];
  /** Local interface (NIC) IPv4 to bind/join on (multi-homed hosts). */
  localaddr?: string;
  /** ffmpeg `fifo_size` (receiving circular buffer, in 188-byte packets). */
  fifoSize?: number;
  /** ffmpeg `overrun_nonfatal`. Defaults ON ({@link MPEGTS_DEFAULT_OVERRUN_NONFATAL}). */
  overrunNonfatal?: boolean;
}

/** Result of {@link parseMpegtsSource}: the canonical URL + its decoded parts. */
export interface ParsedMpegtsSource {
  /** Canonical ffmpeg input URL: `udp://@<host>:<port>?<params>` (deterministic). */
  sourceUrl: string;
  /** Multicast group / unicast bind host (empty = INADDR_ANY unicast receive). */
  host: string;
  /** UDP port (1..65535). */
  port: number;
  /** True when `host` is an IPv4 multicast group (224.0.0.0/4). */
  multicast: boolean;
  /** Validated SSM include source IPs (may be empty). */
  ssmSources: string[];
  /** Validated SSM exclude source IPs (may be empty). */
  blockSources: string[];
  /** Local interface IPv4, when set. */
  localaddr?: string;
  /** Effective `fifo_size`, when set. */
  fifoSize?: number;
  /** Effective `overrun_nonfatal`. */
  overrunNonfatal: boolean;
}

/** Thrown on any invalid MPEG-TS source; the controller maps it to a 400. */
export class MpegtsSourceError extends Error {}

/** Strict dotted-quad IPv4 check (no leading zeros, each octet 0..255). */
export function isValidIpv4(s: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return false;
  return m.slice(1, 5).every((o) => {
    const n = Number(o);
    return n >= 0 && n <= 255 && String(n) === o;
  });
}

/** Whether an address is an IPv4 multicast group (224.0.0.0/4). */
export function isMulticastIpv4(s: string): boolean {
  if (!isValidIpv4(s)) return false;
  const first = Number(s.split('.')[0]);
  return first >= MPEGTS_MULTICAST_MIN_OCTET && first <= MPEGTS_MULTICAST_MAX_OCTET;
}

function normalizeIpList(
  raw: string | string[] | undefined,
  label: string,
): string[] {
  if (raw === undefined || raw === null) return [];
  const parts = (Array.isArray(raw) ? raw : String(raw).split(','))
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length > MPEGTS_MAX_SOURCE_IPS) {
    throw new MpegtsSourceError(
      `${label} accepts at most ${MPEGTS_MAX_SOURCE_IPS} source addresses`,
    );
  }
  for (const p of parts) {
    if (!isValidIpv4(p)) {
      throw new MpegtsSourceError(`${label} must be a comma-separated list of IPv4 addresses (got "${p}")`);
    }
  }
  return parts;
}

interface RawUdp {
  host: string;
  port: number;
  query: Record<string, string>;
}

/** Parse `udp://[@]HOST:PORT[?k=v&…]` into host/port/query. Throws on anything else. */
function parseUdpUrl(raw: string): RawUdp {
  const s = (raw ?? '').trim();
  const m = /^udp:\/\/(@)?([^:/?#]*)(?::(\d+))?(?:\?(.*))?$/i.exec(s);
  if (!m) {
    throw new MpegtsSourceError(
      'source must be a udp:// URL, e.g. udp://@239.1.1.1:5000 (multicast) or udp://@:5000 (unicast)',
    );
  }
  const host = m[2] ?? '';
  if (m[3] === undefined) {
    throw new MpegtsSourceError('source udp:// URL must include a port (udp://@HOST:PORT)');
  }
  const port = Number(m[3]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new MpegtsSourceError(`source port must be between 1 and 65535 (got ${m[3]})`);
  }
  const query: Record<string, string> = {};
  if (m[4]) {
    for (const pair of m[4].split('&')) {
      if (!pair) continue;
      const eq = pair.indexOf('=');
      const key = (eq === -1 ? pair : pair.slice(0, eq)).trim();
      const val = eq === -1 ? '' : decodeURIComponent(pair.slice(eq + 1)).trim();
      if (!ALLOWED_QUERY_KEYS.has(key)) {
        throw new MpegtsSourceError(
          `unsupported query parameter "${key}" — allowed: ${[...ALLOWED_QUERY_KEYS].join(', ')}`,
        );
      }
      query[key] = val;
    }
  }
  return { host, port, query };
}

/**
 * Validate + canonicalize an MPEG-TS-over-UDP source. Structured DTO fields take
 * precedence over the same option carried in the udp:// url's query. Returns the
 * deterministic ffmpeg input URL (used verbatim as `-i`) plus the decoded parts.
 * Throws {@link MpegtsSourceError} on any invalid component.
 */
export function parseMpegtsSource(opts: MpegtsSourceOptions): ParsedMpegtsSource {
  const { host, port, query } = parseUdpUrl(opts.url);

  // Host: empty (INADDR_ANY unicast receive) OR a valid IPv4 (multicast group or
  // a unicast bind address). Hostnames are intentionally NOT accepted — a
  // multicast group is always a literal class-D address.
  if (host && !isValidIpv4(host)) {
    throw new MpegtsSourceError(
      `source host must be an IPv4 address or empty (got "${host}")`,
    );
  }
  const multicast = host !== '' && isMulticastIpv4(host);

  // Merge: explicit DTO field wins over the url query.
  const ssmSources = normalizeIpList(opts.sources ?? query.sources, 'sources');
  const blockSources = normalizeIpList(opts.block ?? query.block, 'block');
  if ((ssmSources.length || blockSources.length) && !multicast) {
    throw new MpegtsSourceError(
      'sources=/block= (source-specific multicast) require a multicast group host (224.0.0.0/4)',
    );
  }

  const localaddr = (opts.localaddr ?? query.localaddr ?? '').trim() || undefined;
  if (localaddr && !isValidIpv4(localaddr)) {
    throw new MpegtsSourceError(`localaddr must be an IPv4 interface address (got "${localaddr}")`);
  }

  let fifoSize = opts.fifoSize;
  if (fifoSize === undefined && query.fifo_size !== undefined) {
    fifoSize = Number(query.fifo_size);
  }
  if (fifoSize !== undefined) {
    if (!Number.isInteger(fifoSize) || fifoSize < MPEGTS_MIN_FIFO_SIZE || fifoSize > MPEGTS_MAX_FIFO_SIZE) {
      throw new MpegtsSourceError(
        `fifo_size must be an integer in [${MPEGTS_MIN_FIFO_SIZE}, ${MPEGTS_MAX_FIFO_SIZE}] packets`,
      );
    }
  }

  let overrunNonfatal = opts.overrunNonfatal;
  if (overrunNonfatal === undefined && query.overrun_nonfatal !== undefined) {
    overrunNonfatal = query.overrun_nonfatal === '1' || query.overrun_nonfatal === 'true';
  }
  if (overrunNonfatal === undefined) overrunNonfatal = MPEGTS_DEFAULT_OVERRUN_NONFATAL;

  const sourceUrl = buildUdpUrl({
    host,
    port,
    ssmSources,
    blockSources,
    localaddr,
    fifoSize,
    overrunNonfatal,
  });
  return {
    sourceUrl,
    host,
    port,
    multicast,
    ssmSources,
    blockSources,
    localaddr,
    fifoSize,
    overrunNonfatal,
  };
}

/**
 * Build the canonical ffmpeg udp:// receive URL from already-validated parts.
 * Query keys are emitted in a STABLE order so the output is deterministic (and
 * unit-testable). `overrun_nonfatal` is always present; `fifo_size`/`localaddr`/
 * `sources`/`block` only when set.
 */
export function buildUdpUrl(parts: {
  host: string;
  port: number;
  ssmSources?: string[];
  blockSources?: string[];
  localaddr?: string;
  fifoSize?: number;
  overrunNonfatal: boolean;
}): string {
  const q: string[] = [];
  if (parts.ssmSources && parts.ssmSources.length) {
    q.push(`sources=${parts.ssmSources.join(',')}`);
  }
  if (parts.blockSources && parts.blockSources.length) {
    q.push(`block=${parts.blockSources.join(',')}`);
  }
  if (parts.localaddr) q.push(`localaddr=${parts.localaddr}`);
  if (parts.fifoSize !== undefined) q.push(`fifo_size=${parts.fifoSize}`);
  q.push(`overrun_nonfatal=${parts.overrunNonfatal ? 1 : 0}`);
  return `udp://@${parts.host}:${parts.port}?${q.join('&')}`;
}
