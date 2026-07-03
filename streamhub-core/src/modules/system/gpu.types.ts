/**
 * StreamHub — GPU / hardware-transcoding domain types (system module).
 *
 * These describe the runtime GPU capability of the NODE the core (and its
 * co-located egress/ingress workers) run on. Detection is best-effort and
 * NEVER throws: a node with no GPU, no driver, or no permission simply reports
 * `available:false, type:'none'`.
 */

/** Kind of hardware video acceleration a device provides. */
export type GpuType = 'nvidia' | 'vaapi' | 'none';

/** Per-app hardware-acceleration preference (SPEC §5 transcoding). */
export type HwaccelMode = 'auto' | 'gpu' | 'cpu';

/** A single detected acceleration-capable device. */
export interface GpuDevice {
  /** Acceleration family this device belongs to. */
  kind: Exclude<GpuType, 'none'>;
  /**
   * Human label: NVIDIA product name (e.g. "NVIDIA GeForce RTX 3090") or the
   * VAAPI render node path (e.g. "/dev/dri/renderD128").
   */
  name: string;
  /** NVIDIA GPU index, when known. */
  index?: number;
  /** Total memory in MiB, when reported (NVIDIA only). */
  memoryMiB?: number;
}

/**
 * Result of a GPU probe. `available` is the single boolean callers gate on;
 * `type` names the acceleration family to use downstream.
 */
export interface GpuStatus {
  /** True when at least one usable acceleration device was found. */
  available: boolean;
  /** Acceleration family selected (nvidia preferred over vaapi). */
  type: GpuType;
  /** Devices found (empty when `type:'none'`). */
  devices: GpuDevice[];
  /** Driver/version string when detectable (e.g. NVIDIA driver, VAAPI driver). */
  driver?: string;
  /** ISO-8601 timestamp of the probe. */
  checkedAt: string;
  /**
   * Short human note about how the result was reached / why unavailable
   * (e.g. "nvidia-smi not found", "no /dev/dri render nodes"). Never a secret.
   */
  detail?: string;
}

/**
 * Resolution of an app's `hwaccel` preference against the live GPU status.
 * `effective` is what the media pipeline will actually use after fallback.
 */
export interface HwaccelDecision {
  /** The configured preference for the app. */
  requested: HwaccelMode;
  /** What will actually be used (never 'auto'; resolves to gpu or cpu). */
  effective: 'gpu' | 'cpu';
  /** Acceleration family when `effective:'gpu'`, else 'none'. */
  type: GpuType;
  /** Human explanation (configured/auto + availability + fallback). */
  reason: string;
}
