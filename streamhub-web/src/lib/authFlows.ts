/**
 * Pure helpers for the auth flows (login 2FA step, magic-link resend cooldown,
 * signup validation). Dependency-free at runtime (only duck-typing on the API
 * error shape) so they run under node:test.
 */

/** Loose shape of an ApiRequestError (duck-typed to stay runtime-dep-free). */
interface ApiErrorLike {
  status?: number
  message?: string
  body?: unknown
}

function asApiError(err: unknown): ApiErrorLike {
  return typeof err === 'object' && err !== null ? (err as ApiErrorLike) : {}
}

function bodyMessage(err: ApiErrorLike): string {
  const body = err.body
  if (typeof body === 'object' && body !== null) {
    const m = (body as { message?: unknown }).message
    if (typeof m === 'string') return m
  }
  return typeof err.message === 'string' ? err.message : ''
}

/**
 * True when the backend answered 401 `totp_required` — the account has 2FA
 * enabled and the client must re-submit the SAME credentials plus a code.
 */
export function isTotpRequired(err: unknown): boolean {
  const e = asApiError(err)
  return e.status === 401 && bodyMessage(e) === 'totp_required'
}

/** True when the supplied TOTP code was wrong (retry with a fresh one). */
export function isTotpInvalid(err: unknown): boolean {
  const e = asApiError(err)
  return e.status === 401 && bodyMessage(e) === 'totp_invalid'
}

/**
 * Seconds to wait before re-requesting a magic link, from a 429 cooldown
 * response ({ retryAfterSeconds } in the body). Null when the error is not a
 * cooldown 429 (callers fall back to their generic error handling).
 */
export function cooldownSecondsFrom(err: unknown): number | null {
  const e = asApiError(err)
  if (e.status !== 429) return null
  const body = e.body
  if (typeof body === 'object' && body !== null) {
    const v = (body as { retryAfterSeconds?: unknown }).retryAfterSeconds
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
      return Math.ceil(v)
    }
  }
  // A 429 without the field is still a cooldown/rate-limit — use the default.
  return DEFAULT_COOLDOWN_SECONDS
}

/** Default resend spacing (mirrors the backend's RESEND_COOLDOWN_SECONDS). */
export const DEFAULT_COOLDOWN_SECONDS = 60

/** Signup form validation error keys (i18n-ready; null = valid). */
export type SignupError =
  | 'invalidEmail'
  | 'passwordTooShort'
  | 'passwordMismatch'
  | null

export const SIGNUP_MIN_PASSWORD = 8

/** Validate the signup form fields. Returns the FIRST problem, or null. */
export function validateSignup(input: {
  email: string
  password: string
  confirm: string
}): SignupError {
  const email = input.email.trim()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) {
    return 'invalidEmail'
  }
  if (input.password.length < SIGNUP_MIN_PASSWORD) return 'passwordTooShort'
  if (input.password !== input.confirm) return 'passwordMismatch'
  return null
}

/** Clamp + format a countdown as `Ns` (UI label for the disabled resend). */
export function formatCooldown(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds))
  return `${s}s`
}
