/**
 * OS tuning — the knob catalogue, the pure verdict logic, and the filesystem
 * reader that feeds it. Everything here is dependency-free and deterministic
 * given a {@link TuningReader}, so the "fake /proc values → applied/not-applied"
 * mapping is unit-tested without any real I/O (the service just wires the real
 * fs-backed reader into {@link buildReport}).
 *
 * Knob selection cross-references what `install.sh` already sets on a real host
 * (UDP rmem/wmem ≈ 16 MiB in /etc/sysctl.d/99-streamhub-webrtc.conf, plus the
 * systemd `LimitNOFILE` in deploy/*.service) and the LiveKit deployment guide
 * (large UDP socket buffers, wide ephemeral port range, high fd limits).
 */
import * as fs from 'fs';

import {
  OsTuningKnob,
  OsTuningReport,
  OsTuningSummary,
  TuningSource,
  TuningStatus,
} from './os-tuning.types';

/** 16 MiB — the UDP buffer floor LiveKit recommends and install.sh applies. */
export const UDP_BUFFER_MIN = 16 * 1024 * 1024; // 16777216

/** Verdict function: raw file content → status. `raw === null` ⇒ unknown. */
type Verdict = (raw: string | null) => TuningStatus;

/** First whitespace-separated token of a value, parsed as an integer. */
function firstInt(raw: string): number | null {
  const tok = raw.trim().split(/\s+/)[0]?.toLowerCase();
  if (tok === 'unlimited') return Number.POSITIVE_INFINITY;
  const n = Number.parseInt(tok ?? '', 10);
  return Number.isFinite(n) ? n : null;
}

/** applied ⇔ value ≥ threshold (single-number knobs + soft limits). */
function gte(threshold: number): Verdict {
  return (raw) => {
    if (raw == null) return 'unknown';
    const n = firstInt(raw);
    if (n == null) return 'unknown';
    return n >= threshold ? 'applied' : 'not-applied';
  };
}

/** applied ⇔ value ≤ threshold (e.g. vm.swappiness). */
function lte(threshold: number): Verdict {
  return (raw) => {
    if (raw == null) return 'unknown';
    const n = firstInt(raw);
    if (n == null) return 'unknown';
    return n <= threshold ? 'applied' : 'not-applied';
  };
}

/**
 * net.ipv4.udp_mem is three page counts: `min pressure max`. The last column
 * (max) is the hard ceiling that throttles UDP under heavy media load, so the
 * verdict checks it against a floor.
 */
function udpMemMaxGte(thresholdPages: number): Verdict {
  return (raw) => {
    if (raw == null) return 'unknown';
    const parts = raw.trim().split(/\s+/).map((p) => Number.parseInt(p, 10));
    if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) {
      return 'unknown';
    }
    return parts[2] >= thresholdPages ? 'applied' : 'not-applied';
  };
}

/**
 * net.ipv4.ip_local_port_range is `low high`. A media server holding many
 * outbound/relay sockets wants a WIDE ephemeral range reaching near 65535.
 */
function portRange(minWidth: number, minHigh: number): Verdict {
  return (raw) => {
    if (raw == null) return 'unknown';
    const [lo, hi] = raw.trim().split(/\s+/).map((p) => Number.parseInt(p, 10));
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return 'unknown';
    return hi - lo + 1 >= minWidth && hi >= minHigh ? 'applied' : 'not-applied';
  };
}

/**
 * transparent_hugepage/enabled looks like `always [madvise] never` — the active
 * mode is the bracketed token. `always` hurts latency-sensitive workloads, so
 * anything other than `always` counts as applied.
 */
function thpNotAlways(): Verdict {
  return (raw) => {
    if (raw == null) return 'unknown';
    const m = /\[([a-z]+)\]/.exec(raw.trim());
    if (!m) return 'unknown';
    return m[1] === 'always' ? 'not-applied' : 'applied';
  };
}

/** A knob definition: metadata + how to read it + how to judge it. */
interface KnobDef {
  id: string;
  label: string;
  source: TuningSource;
  key: string;
  recommended: string;
  why: string;
  remedy: string;
  optional?: boolean;
  verdict: Verdict;
}

/**
 * The knob catalogue. Order = display order (network buffers first, since they
 * are the ones that actually drop WebRTC media when left at the default).
 */
export const KNOBS: readonly KnobDef[] = [
  {
    id: 'net.core.rmem_max',
    label: 'UDP receive buffer max',
    source: 'sysctl',
    key: 'net.core.rmem_max',
    recommended: `≥ ${UDP_BUFFER_MIN} (16 MiB)`,
    why: 'WebRTC/RTP media arrives over UDP; the ~208 KB default drops packets when several publishers/subscribers saturate the socket. install.sh raises this to 16 MiB.',
    remedy: `sysctl -w net.core.rmem_max=${UDP_BUFFER_MIN}   # persist in /etc/sysctl.d/99-streamhub-webrtc.conf`,
    verdict: gte(UDP_BUFFER_MIN),
  },
  {
    id: 'net.core.wmem_max',
    label: 'UDP send buffer max',
    source: 'sysctl',
    key: 'net.core.wmem_max',
    recommended: `≥ ${UDP_BUFFER_MIN} (16 MiB)`,
    why: 'Send-side counterpart of rmem_max: a small default throttles outbound RTP to subscribers under load. install.sh raises this to 16 MiB.',
    remedy: `sysctl -w net.core.wmem_max=${UDP_BUFFER_MIN}   # persist in /etc/sysctl.d/99-streamhub-webrtc.conf`,
    verdict: gte(UDP_BUFFER_MIN),
  },
  {
    id: 'net.core.somaxconn',
    label: 'Listen backlog (somaxconn)',
    source: 'sysctl',
    key: 'net.core.somaxconn',
    recommended: '≥ 1024',
    why: 'Caps the accept() queue for TCP signalling/HLS/API. A low backlog drops connections during viewer surges (joins after a broadcast starts).',
    remedy: 'sysctl -w net.core.somaxconn=1024',
    verdict: gte(1024),
  },
  {
    id: 'net.ipv4.udp_mem',
    label: 'UDP memory ceiling (udp_mem max)',
    source: 'sysctl',
    key: 'net.ipv4.udp_mem',
    recommended: 'max ≥ 262144 pages (~1 GiB)',
    why: 'System-wide UDP memory pressure thresholds (min/pressure/max, in pages). A low max column throttles all UDP once media load grows.',
    remedy: 'sysctl -w net.ipv4.udp_mem="65536 131072 262144"',
    verdict: udpMemMaxGte(262144),
  },
  {
    id: 'net.ipv4.ip_local_port_range',
    label: 'Ephemeral port range',
    source: 'sysctl',
    key: 'net.ipv4.ip_local_port_range',
    recommended: '1024 65535 (wide range)',
    why: 'A media server holds many relay/outbound sockets; a narrow ephemeral range exhausts ports and refuses new connections.',
    remedy: 'sysctl -w net.ipv4.ip_local_port_range="1024 65535"',
    verdict: portRange(16384, 60999),
  },
  {
    id: 'fs.file-max',
    label: 'System-wide file-descriptor cap',
    source: 'sysctl',
    key: 'fs.file-max',
    recommended: '≥ 1000000',
    why: 'Every socket, HLS segment and recording is a file descriptor. A low system cap makes the kernel refuse new fds server-wide under load.',
    remedy: 'sysctl -w fs.file-max=1000000',
    verdict: gte(1_000_000),
  },
  {
    id: 'nofile',
    label: 'Process open-files limit (ulimit -n)',
    source: 'limits',
    key: 'Max open files',
    recommended: '≥ 65535 (units set LimitNOFILE 200000/500000)',
    why: 'Per-process fd ceiling for the core/LiveKit. Too low and the process hits EMFILE under many concurrent viewers. deploy/*.service set LimitNOFILE high.',
    remedy: 'LimitNOFILE=200000 in the systemd unit   # or: ulimit -n 65535',
    verdict: gte(65535),
  },
  {
    id: 'vm.swappiness',
    label: 'Swappiness',
    source: 'sysctl',
    key: 'vm.swappiness',
    recommended: '≤ 10',
    why: 'High swappiness lets the kernel swap out hot media/jitter buffers, spiking latency and stalls. Keep the media path in RAM.',
    remedy: 'sysctl -w vm.swappiness=10',
    verdict: lte(10),
  },
  {
    id: 'transparent_hugepage',
    label: 'Transparent hugepages',
    source: 'sys',
    key: '/sys/kernel/mm/transparent_hugepage/enabled',
    recommended: 'madvise or never (not always)',
    why: 'THP=always causes latency spikes from background compaction — bad for real-time media. `madvise`/`never` avoids the stalls. Optional.',
    remedy: 'echo madvise > /sys/kernel/mm/transparent_hugepage/enabled',
    optional: true,
    verdict: thpNotAlways(),
  },
];

/**
 * Reads raw knob values off the host. The one seam the tests replace with a
 * fake so verdict mapping is exercised without touching a real `/proc`.
 */
export interface TuningReader {
  /** `process.platform` — 'linux' where `/proc` tuning is inspectable. */
  readonly platform: string;
  /** Raw value for a knob, or null when unreadable / absent / non-Linux. */
  read(knob: Pick<KnobDef, 'source' | 'key'>): string | null;
}

/**
 * Build the full report from a reader. Pure: same reader ⇒ same report (minus
 * the timestamp). On a non-Linux platform every knob is `unknown` and
 * `supported` is false. This is the function the evaluator drives with fake
 * `/proc` values.
 */
export function buildReport(reader: TuningReader): OsTuningReport {
  const supported = reader.platform === 'linux';
  const knobs: OsTuningKnob[] = KNOBS.map((def) => {
    const raw = supported ? normalize(reader.read(def)) : null;
    const status: TuningStatus = supported ? def.verdict(raw) : 'unknown';
    return {
      id: def.id,
      label: def.label,
      source: def.source,
      key: def.key,
      current: raw,
      recommended: def.recommended,
      status,
      why: def.why,
      remedy: def.remedy,
      optional: Boolean(def.optional),
    };
  });

  const summary: OsTuningSummary = { applied: 0, notApplied: 0, unknown: 0 };
  for (const k of knobs) {
    if (k.status === 'applied') summary.applied++;
    else if (k.status === 'not-applied') summary.notApplied++;
    else summary.unknown++;
  }

  return {
    checkedAt: new Date().toISOString(),
    platform: reader.platform,
    supported,
    summary,
    knobs,
    note: supported
      ? 'install.sh applies the network/fd tunings on a real host (sysctl + systemd LimitNOFILE). Values shown are live; this endpoint never writes.'
      : 'Non-Linux host: /proc tuning is not inspectable here. These knobs apply on the production Linux host, where install.sh sets them.',
  };
}

/** Trim raw content; treat empty as null so an empty file reads as unknown. */
function normalize(raw: string | null): string | null {
  if (raw == null) return null;
  const t = raw.trim();
  return t.length > 0 ? t : null;
}

/** Absolute path of a sysctl key's `/proc/sys` file (dots → slashes). */
export function sysctlPath(key: string): string {
  return `/proc/sys/${key.replace(/\./g, '/')}`;
}

/**
 * The real fs-backed reader. Every read is wrapped so a missing file / denied
 * permission / odd content degrades to null (never throws). `/proc/self/limits`
 * is parsed once per call for `limits`-sourced knobs.
 */
export function createProcReader(): TuningReader {
  let limitsText: string | null | undefined; // memoized per reader instance

  const readLimitsRow = (rowName: string): string | null => {
    if (limitsText === undefined) {
      try {
        limitsText = fs.readFileSync('/proc/self/limits', 'utf8');
      } catch {
        limitsText = null;
      }
    }
    if (!limitsText) return null;
    for (const line of limitsText.split('\n')) {
      if (line.startsWith(rowName)) {
        // "Max open files            1024                 1048576              files"
        const rest = line.slice(rowName.length).trim().split(/\s+/);
        return rest[0] ?? null; // soft limit
      }
    }
    return null;
  };

  const readFile = (path: string): string | null => {
    try {
      return fs.readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  };

  return {
    platform: process.platform,
    read(knob) {
      if (knob.source === 'limits') return readLimitsRow(knob.key);
      if (knob.source === 'sys') return readFile(knob.key);
      return readFile(sysctlPath(knob.key));
    },
  };
}
