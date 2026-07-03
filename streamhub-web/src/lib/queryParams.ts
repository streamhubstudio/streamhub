/**
 * Pure builders that turn the VODs / logs filter state into URLSearchParams.
 *
 * Kept dependency-free (no React, no api client) so the mapping from UI filters
 * to the wire query is unit-testable under node:test. Empty / undefined / null
 * values are dropped so we never send `?room=&status=`.
 */

export type VodOrder = 'started_at' | 'size_bytes' | 'id'
export type SortDir = 'asc' | 'desc'

/** GET /apps/:app/vods filter/paging inputs. */
export interface VodsQueryInput {
  room?: string
  status?: string
  since?: string
  until?: string
  order?: VodOrder
  dir?: SortDir
  /** When true, the backend ignores limit/offset and returns everything. */
  all?: boolean
  limit?: number
  offset?: number
}

/** GET /apps/:app/logs (and the global /logs) filter/paging inputs. */
export interface LogsQueryInput {
  /** Only used by the global /logs endpoint (per-app path fixes the app). */
  app?: string
  level?: string
  source?: string
  /** Free-text search over the message. */
  q?: string
  since?: string
  until?: string
  limit?: number
  offset?: number
}

/** True when a value is worth serialising (drops undefined/null/'' but keeps 0/false). */
function present(v: unknown): boolean {
  return v !== undefined && v !== null && v !== ''
}

/** Append every present entry to a URLSearchParams, stringifying primitives. */
function appendAll(
  sp: URLSearchParams,
  entries: Array<[string, string | number | boolean | undefined | null]>,
): URLSearchParams {
  for (const [k, v] of entries) {
    if (present(v)) sp.append(k, String(v))
  }
  return sp
}

/** Build the query string for GET /apps/:app/vods. */
export function buildVodsQuery(input: VodsQueryInput = {}): URLSearchParams {
  return appendAll(new URLSearchParams(), [
    ['room', input.room?.trim()],
    ['status', input.status],
    ['since', input.since],
    ['until', input.until],
    ['order', input.order],
    ['dir', input.dir],
    // Only send `all` when explicitly true (the backend defaults to paged).
    ['all', input.all ? true : undefined],
    ['limit', input.limit],
    ['offset', input.offset],
  ])
}

/** GET /apps/:app/ingress filter/paging inputs (paginated ingress listing). */
export interface IngressQueryInput {
  /** Room filter (bare name or already app-prefixed). */
  room?: string
  /** Free-text filter over ingress id / name / room. */
  q?: string
  limit?: number
  offset?: number
}

/** Build the query string for GET /apps/:app/ingress. */
export function buildIngressQuery(
  input: IngressQueryInput = {},
): URLSearchParams {
  return appendAll(new URLSearchParams(), [
    ['room', input.room?.trim()],
    ['q', input.q?.trim()],
    ['limit', input.limit],
    ['offset', input.offset],
  ])
}

/** Build the query string for GET /apps/:app/logs and the global /logs. */
export function buildLogsQuery(input: LogsQueryInput = {}): URLSearchParams {
  return appendAll(new URLSearchParams(), [
    ['app', input.app?.trim()],
    ['level', input.level],
    ['source', input.source?.trim()],
    ['q', input.q?.trim()],
    ['since', input.since],
    ['until', input.until],
    ['limit', input.limit],
    ['offset', input.offset],
  ])
}

/** URLSearchParams → plain record, for the api client's `query` option. */
export function toQueryRecord(
  sp: URLSearchParams,
): Record<string, string> {
  return Object.fromEntries(sp.entries())
}
