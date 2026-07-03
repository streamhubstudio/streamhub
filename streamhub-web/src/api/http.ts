/**
 * Low-level HTTP layer for the streamhub-core API.
 *
 * Responsibilities:
 *  - Prefix every request with the API base (/api/v1).
 *  - Attach `Authorization: Bearer <jwt>` from localStorage.
 *  - Unwrap the { data, error } envelope OR return plain bodies as-is.
 *  - Surface a typed ApiRequestError (with .status) for non-2xx + envelope errors.
 *  - Notify a 401 handler so the auth layer can log the user out.
 */
import type { ApiEnvelope } from './types'

export const API_BASE = '/api/v1'
const TOKEN_KEY = 'streamhub.token'

// --- token storage (single source of truth) --------------------------------

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export function setToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token)
  } catch {
    /* storage unavailable — ignore */
  }
}

export function clearToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY)
  } catch {
    /* ignore */
  }
}

// --- 401 handling -----------------------------------------------------------

type UnauthorizedHandler = () => void
let onUnauthorized: UnauthorizedHandler | null = null

/** Register a callback invoked whenever the API answers 401. */
export function setUnauthorizedHandler(fn: UnauthorizedHandler | null): void {
  onUnauthorized = fn
}

// --- error type -------------------------------------------------------------

export class ApiRequestError extends Error {
  status: number
  body: unknown

  constructor(message: string, status: number, body?: unknown) {
    super(message)
    this.name = 'ApiRequestError'
    this.status = status
    this.body = body
  }
}

// --- request options --------------------------------------------------------

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  /** JSON body — serialized automatically. */
  body?: unknown
  /** Query params; undefined/null entries are dropped. */
  query?: Record<string, string | number | boolean | undefined | null>
  /** Skip the Authorization header (e.g. login). */
  auth?: boolean
  signal?: AbortSignal
  /**
   * When true, the response body is returned untouched (plain object).
   * Used for /health and /stats, which are NOT wrapped in an envelope.
   */
  plain?: boolean
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const url = `${API_BASE}${path.startsWith('/') ? path : `/${path}`}`
  if (!query) return url
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== '') qs.append(k, String(v))
  }
  const s = qs.toString()
  return s ? `${url}?${s}` : url
}

/**
 * Core request. Returns the unwrapped payload (`data` for enveloped endpoints,
 * or the raw body when `plain` is set).
 */
export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, query, auth = true, signal, plain = false } = opts

  const headers: Record<string, string> = { Accept: 'application/json' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (auth) {
    const token = getToken()
    if (token) headers.Authorization = `Bearer ${token}`
  }

  let res: Response
  try {
    res = await fetch(buildUrl(path, query), {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    })
  } catch (err) {
    throw new ApiRequestError(
      err instanceof Error ? err.message : 'Network error',
      0,
      err,
    )
  }

  if (res.status === 401) {
    onUnauthorized?.()
  }

  // 204 No Content — nothing to parse.
  if (res.status === 204) {
    return undefined as T
  }

  const text = await res.text()
  let parsed: unknown = undefined
  if (text) {
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = text
    }
  }

  if (!res.ok) {
    const msg = extractError(parsed) ?? `HTTP ${res.status}`
    throw new ApiRequestError(msg, res.status, parsed)
  }

  if (plain) {
    return parsed as T
  }

  // Enveloped: { data, error }
  if (isEnvelope(parsed)) {
    if (parsed.error) {
      throw new ApiRequestError(
        extractError(parsed.error) ?? 'API error',
        res.status,
        parsed.error,
      )
    }
    return parsed.data as T
  }

  // Fallback: endpoint didn't envelope — return as-is.
  return parsed as T
}

function isEnvelope(v: unknown): v is ApiEnvelope<unknown> {
  return (
    typeof v === 'object' &&
    v !== null &&
    ('data' in (v as object) || 'error' in (v as object))
  )
}

function extractError(v: unknown): string | null {
  if (!v) return null
  if (typeof v === 'string') return v
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    if (typeof o.message === 'string') return o.message
    if (typeof o.error === 'string') return o.error
  }
  return null
}
