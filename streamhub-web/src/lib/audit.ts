/**
 * Pure helpers for the superadmin "Audit log" and "Security posture" surfaces.
 *
 * Kept dependency-free (no React, no api client) so the mapping from UI filter
 * state to the wire query, the state → badge-tone mappings and the summary
 * fallback are all unit-testable under node:test. Empty / undefined text
 * filters are dropped so we never send `?action=&actor=`; limit is clamped to
 * the backend's accepted range.
 */
import type { AuditResult, ComplianceControl, ComplianceState } from '@/api'

/** Shared badge tone vocabulary (matches the Tag pills used across settings). */
export type PostureTone = 'green' | 'amber' | 'red' | 'slate'

/** GET /system/audit accepts limit default 50, max 500. */
export const AUDIT_DEFAULT_LIMIT = 50
export const AUDIT_MAX_LIMIT = 500

/** Filter/paging inputs for GET /system/audit (audit log listing). */
export interface AuditQueryInput {
  /** Dotted action prefix, e.g. `auth.` or `token.create`. */
  action?: string
  /** Exact actorId. */
  actor?: string
  /** Exact result (empty = any). */
  result?: AuditResult | ''
  /** ISO date lower/upper bounds. */
  from?: string
  to?: string
  limit?: number
  offset?: number
}

/** Clamp the page size into [1, 500], defaulting bad/empty input to 50. */
export function clampLimit(limit: number | undefined | null): number {
  if (limit == null || !Number.isFinite(limit)) return AUDIT_DEFAULT_LIMIT
  const n = Math.floor(limit)
  if (n <= 0) return AUDIT_DEFAULT_LIMIT
  return Math.min(n, AUDIT_MAX_LIMIT)
}

/** Non-negative integer offset (defaults/floors to 0). */
export function clampOffset(offset: number | undefined | null): number {
  if (offset == null || !Number.isFinite(offset)) return 0
  const n = Math.floor(offset)
  return n > 0 ? n : 0
}

/**
 * Build the query string for GET /system/audit. Text filters are trimmed and
 * dropped when empty; `limit`/`offset` are always present (paging is inherent)
 * with `limit` clamped to the backend's [1, 500] range.
 */
export function buildAuditQuery(input: AuditQueryInput = {}): URLSearchParams {
  const sp = new URLSearchParams()
  const action = input.action?.trim()
  const actor = input.actor?.trim()
  if (action) sp.append('action', action)
  if (actor) sp.append('actor', actor)
  if (input.result) sp.append('result', input.result)
  if (input.from) sp.append('from', input.from)
  if (input.to) sp.append('to', input.to)
  sp.append('limit', String(clampLimit(input.limit)))
  sp.append('offset', String(clampOffset(input.offset)))
  return sp
}

// --- posture / result badge tones --------------------------------------------

const POSTURE_TONES: Record<ComplianceState, PostureTone> = {
  active: 'green',
  partial: 'amber',
  off: 'red',
  unknown: 'slate',
}

/**
 * Badge tone for a compliance control state: active→green, partial→amber,
 * off→red, unknown (and any unexpected value) → slate/gray.
 */
export function postureStateTone(state: ComplianceState | string | undefined): PostureTone {
  return POSTURE_TONES[state as ComplianceState] ?? 'slate'
}

/**
 * Badge tone for an audit entry result: success→green (positive),
 * failure→amber, deny→red. Anything unexpected degrades to slate.
 */
export function auditResultTone(result: AuditResult | string | undefined): PostureTone {
  if (result === 'success') return 'green'
  if (result === 'failure') return 'amber'
  if (result === 'deny') return 'red'
  return 'slate'
}

// --- compliance summary (client-side fallback) -------------------------------

/** Per-state control counts (mirrors the backend ComplianceSummary). */
export interface ComplianceSummaryCounts {
  active: number
  partial: number
  off: number
  unknown: number
}

/**
 * Count controls by state. Used as a fallback when the backend omits `summary`
 * (or it drifts from the control list). Unrecognised states fold into `unknown`.
 */
export function computeSummary(
  controls: ComplianceControl[] | undefined,
): ComplianceSummaryCounts {
  const summary: ComplianceSummaryCounts = { active: 0, partial: 0, off: 0, unknown: 0 }
  for (const c of controls ?? []) {
    if (c.state === 'active' || c.state === 'partial' || c.state === 'off') {
      summary[c.state] += 1
    } else {
      summary.unknown += 1
    }
  }
  return summary
}
