/**
 * Pure helpers for the read-only "OS tuning" panel (GET /system/os-tuning).
 *
 * Kept dependency-free (no React, no api client) so the status → badge-tone
 * mapping and the summary fallback are unit-testable under node:test, exactly
 * like @/lib/audit does for the compliance posture.
 */
import type { OsTuningKnob, OsTuningSummary, TuningStatus } from '@/api'

/** Shared badge tone vocabulary (matches the Tag pills across settings). */
export type TuningTone = 'green' | 'amber' | 'slate'

const STATUS_TONES: Record<TuningStatus, TuningTone> = {
  applied: 'green',
  'not-applied': 'amber',
  unknown: 'slate',
}

/**
 * Badge tone for a tuning verdict: applied→green, not-applied→amber,
 * unknown (n/a) and any unexpected value → slate/gray.
 */
export function tuningStatusTone(status: TuningStatus | string | undefined): TuningTone {
  return STATUS_TONES[status as TuningStatus] ?? 'slate'
}

/**
 * Count knobs by status. Used as a fallback when the backend omits `summary`
 * (or it drifts from the knob list). Unrecognised statuses fold into `unknown`.
 */
export function computeTuningSummary(
  knobs: OsTuningKnob[] | undefined,
): OsTuningSummary {
  const summary: OsTuningSummary = { applied: 0, notApplied: 0, unknown: 0 }
  for (const k of knobs ?? []) {
    if (k.status === 'applied') summary.applied += 1
    else if (k.status === 'not-applied') summary.notApplied += 1
    else summary.unknown += 1
  }
  return summary
}
