/**
 * Read-only "OS performance tuning" contract.
 *
 * Reports, per kernel/limit knob that matters for a LiveKit/WebRTC media
 * server, the CURRENT value (read from `/proc/sys/*`, `/proc/self/limits`,
 * `/sys/*`), the RECOMMENDED value, and an applied / not-applied / unknown
 * verdict. It only READS the host — it never applies anything (kernel params
 * must be set on the real host by `install.sh`, not from inside a container).
 *
 * On a non-Linux host (e.g. the macOS test/dev box) `/proc` does not exist, so
 * every knob degrades cleanly to `unknown` and `supported` is false.
 */

/** Verdict for a single tuning knob. */
export type TuningStatus = 'applied' | 'not-applied' | 'unknown';

/** Where a knob's value is read from on Linux. */
export type TuningSource = 'sysctl' | 'limits' | 'sys';

/** One tuning knob as reported to the panel. */
export interface OsTuningKnob {
  /** Stable machine id, e.g. `net.core.rmem_max`. */
  id: string;
  /** Human label shown in the dashboard. */
  label: string;
  /** Where it is read from (sysctl file / process limits / /sys). */
  source: TuningSource;
  /** The sysctl key, `/proc/self/limits` row name, or `/sys` path. */
  key: string;
  /** Raw current value (null when unknown / unavailable / non-Linux). */
  current: string | null;
  /** Recommended value (human string). */
  recommended: string;
  status: TuningStatus;
  /** Why this knob matters for a media server. */
  why: string;
  /** The remedy line (sysctl/ulimit) — copy-paste to apply on the host. */
  remedy: string;
  /** Non-essential knobs (e.g. transparent hugepages) are flagged optional. */
  optional: boolean;
}

/** Per-status knob counts (mirrors the compliance summary rollup). */
export interface OsTuningSummary {
  applied: number;
  notApplied: number;
  unknown: number;
}

/** GET /system/os-tuning — live OS tuning posture of this node. */
export interface OsTuningReport {
  /** ISO timestamp the values were read. */
  checkedAt: string;
  /** `process.platform` of the node the core runs on. */
  platform: string;
  /** True on Linux (where `/proc` tuning can actually be inspected). */
  supported: boolean;
  summary: OsTuningSummary;
  knobs: OsTuningKnob[];
  /** Operator note (install.sh applies these on a real host). */
  note: string;
}
