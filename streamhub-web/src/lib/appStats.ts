/**
 * Pure reductions over the app-stats payload (GET /apps/:app/stats).
 *
 * Kept free of React / api types so the arithmetic the Tablero cards rely on is
 * unit-testable. Tolerates partial / missing objects (the endpoint may not exist
 * yet while the backend agents build it — the UI must degrade, not throw).
 */

/** Mirrors AppStats.vods.byStatus but every key is optional here. */
export interface VodStatusCounts {
  ready?: number
  failed?: number
  recording?: number
  uploading?: number
  [k: string]: number | undefined
}

export interface VodStatusSummary {
  ready: number
  failed: number
  recording: number
  uploading: number
  /** ready + failed + recording + uploading (+ any extra buckets). */
  total: number
  /** In-flight work: recording + uploading. */
  pending: number
}

function n(v: number | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/** Fold a (possibly partial) byStatus map into named + total/pending counts. */
export function reduceVodStatus(
  byStatus: VodStatusCounts | null | undefined,
): VodStatusSummary {
  const s = byStatus ?? {}
  const ready = n(s.ready)
  const failed = n(s.failed)
  const recording = n(s.recording)
  const uploading = n(s.uploading)
  const total = Object.values(s).reduce<number>((acc, v) => acc + n(v), 0)
  return { ready, failed, recording, uploading, total, pending: recording + uploading }
}

/** Sum of error + warn (+ any elevated) 24h event buckets — drives the header badge. */
export function countProblemEvents(
  events: { error?: number; warn?: number } | null | undefined,
): number {
  return n(events?.error) + n(events?.warn)
}
