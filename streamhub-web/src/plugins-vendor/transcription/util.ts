/**
 * Pure helpers for the transcription Studio panel (node:test-covered in
 * util.spec.ts). No React, no fetch — index.tsx is the thin shell.
 */

export type TranscriptStatus = 'queued' | 'processing' | 'ready' | 'failed'
/** `none` = the VOD was never transcribed (GET …/transcript answers 404). */
export type RowStatus = TranscriptStatus | 'none'

export interface TranscriptRow {
  vodId: number
  room: string
  startedAt: string | null
  status: RowStatus
  language: string | null
  srtUrl: string | null
  error: string | null
}

export type Summary = Record<RowStatus, number>

const STATUSES: readonly RowStatus[] = ['queued', 'processing', 'ready', 'failed', 'none']

/** Normalise an unknown wire status (anything unexpected reads as `none`). */
export function toRowStatus(s: unknown): RowStatus {
  return typeof s === 'string' && (STATUSES as readonly string[]).includes(s)
    ? (s as RowStatus)
    : 'none'
}

/** Per-status counts for the header strip. */
export function summarize(rows: readonly TranscriptRow[]): Summary {
  const out: Summary = { queued: 0, processing: 0, ready: 0, failed: 0, none: 0 }
  for (const r of rows) out[r.status]++
  return out
}

/** True while any row is still in flight — the panel keeps polling. */
export function hasPending(rows: readonly TranscriptRow[]): boolean {
  return rows.some((r) => r.status === 'queued' || r.status === 'processing')
}

/** Rows that can be (re)transcribed from the panel. */
export function canTrigger(status: RowStatus): boolean {
  return status === 'none' || status === 'ready' || status === 'failed'
}

export function statusTone(status: RowStatus): 'green' | 'red' | 'amber' | 'slate' {
  if (status === 'ready') return 'green'
  if (status === 'failed') return 'red'
  if (status === 'none') return 'slate'
  return 'amber'
}
