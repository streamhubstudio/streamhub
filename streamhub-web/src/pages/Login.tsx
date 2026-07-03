/**
 * Login — passwordless magic-link (default) with a break-glass admin fallback.
 *
 *  - Default: a single email field + "Email me a login link".
 *    POST /auth/magic-link { email } → confirmation screen ("check your email")
 *    with a resend button that honours the backend's 60s cooldown (a 429 with
 *    retryAfterSeconds drives a live countdown).
 *  - Admin (break-glass): reachable only via /login?admin=1. The old
 *    email/username + password form → POST /auth/login. When the account has
 *    2FA enabled the backend answers 401 `totp_required` and a TOTP code step
 *    appears (same credentials re-submitted with the code).
 *  - "Create account" (→ /signup) is offered ONLY when GET /auth/config says
 *    public signup is enabled on this deployment.
 */
import { useEffect, useState, type FormEvent } from 'react'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { useAuth } from '@/auth/useAuth'
import { api, ApiRequestError } from '@/api'
import {
  cooldownSecondsFrom,
  DEFAULT_COOLDOWN_SECONDS,
  isTotpInvalid,
  isTotpRequired,
} from '@/lib/authFlows'
import { AuthShell, AuthHeading } from '@/components/AuthShell'
import { PasswordInput } from '@/components/PasswordInput'
import { Alert, Button, FormContainer, FormItem, Input } from '@/ui'

interface LocationState {
  from?: { pathname?: string }
}

/** Ticks `seconds` down to 0 once per second. Returns [left, start]. */
function useCountdown(): [number, (seconds: number) => void] {
  const [left, setLeft] = useState(0)
  useEffect(() => {
    if (left <= 0) return
    const t = window.setTimeout(() => setLeft((v) => Math.max(0, v - 1)), 1000)
    return () => window.clearTimeout(t)
  }, [left])
  return [left, setLeft]
}

export default function Login() {
  const { login, requestMagicLink, isAuthenticated } = useAuth()
  const { t } = useTranslation('auth')
  const navigate = useNavigate()
  const location = useLocation()
  const [params, setParams] = useSearchParams()
  const from = (location.state as LocationState | null)?.from?.pathname ?? '/'

  const adminMode = params.get('admin') === '1'

  // Public capabilities — drives the "Create account" affordance.
  const authConfig = useQuery({
    queryKey: ['auth-config'],
    queryFn: ({ signal }) => api.auth.config(signal),
    staleTime: 5 * 60_000,
    retry: false,
  })
  const allowSignup = authConfig.data?.allowSignup === true

  // magic-link state
  const [email, setEmail] = useState('')
  const [sentTo, setSentTo] = useState<string | null>(null)
  const [cooldown, startCooldown] = useCountdown()

  // admin (break-glass) state
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  // 2FA step: shown after a 401 totp_required for the given credentials.
  const [needsCode, setNeedsCode] = useState(false)
  const [code, setCode] = useState('')

  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (isAuthenticated) navigate(from, { replace: true })
  }, [isAuthenticated, from, navigate])

  function goAdmin(on: boolean) {
    setError(null)
    setNeedsCode(false)
    setCode('')
    setParams(on ? { admin: '1' } : {}, { replace: true })
  }

  async function sendMagic(addr: string) {
    setError(null)
    setSubmitting(true)
    try {
      await requestMagicLink(addr)
      setSentTo(addr)
      startCooldown(DEFAULT_COOLDOWN_SECONDS)
    } catch (err) {
      const wait = cooldownSecondsFrom(err)
      if (wait !== null) {
        // Already requested recently — show the confirmation screen with the
        // remaining wait instead of a scary error.
        setSentTo(addr)
        startCooldown(wait)
      } else {
        setError(t('login.error'))
      }
    } finally {
      setSubmitting(false)
    }
  }

  async function onMagicSubmit(e: FormEvent) {
    e.preventDefault()
    void sendMagic(email.trim())
  }

  async function onAdminSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      await login(identifier.trim(), password, needsCode ? code.trim() : undefined)
      navigate(from, { replace: true })
    } catch (err) {
      if (isTotpRequired(err)) {
        setNeedsCode(true)
        setCode('')
      } else if (isTotpInvalid(err)) {
        setNeedsCode(true)
        setError(t('login.totp.errorInvalid'))
      } else {
        setError(
          err instanceof ApiRequestError && err.status === 401
            ? t('login.admin.errorInvalid')
            : t('login.admin.errorFailed'),
        )
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AuthShell>
      {/* ---- Break-glass admin form (only via /login?admin=1) ---- */}
      {adminMode ? (
        <>
          <AuthHeading
            title={needsCode ? t('login.totp.title') : t('login.admin.title')}
            subtitle={
              needsCode ? t('login.totp.subtitle') : t('login.admin.subtitle')
            }
          />

          {error && (
            <Alert showIcon type="danger" className="mb-4">
              {error}
            </Alert>
          )}

          <form onSubmit={onAdminSubmit}>
            <FormContainer>
              {!needsCode ? (
                <>
                  <FormItem label={t('login.admin.identifierLabel')}>
                    <Input
                      type="text"
                      value={identifier}
                      onChange={(e) => setIdentifier(e.target.value)}
                      autoFocus
                      autoComplete="username"
                      placeholder={t('login.emailPlaceholder')}
                    />
                  </FormItem>
                  <FormItem label={t('login.admin.passwordLabel')}>
                    <PasswordInput
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      autoComplete="current-password"
                    />
                  </FormItem>
                </>
              ) : (
                <FormItem label={t('login.totp.codeLabel')}>
                  <Input
                    type="text"
                    inputMode="numeric"
                    maxLength={6}
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                    autoFocus
                    autoComplete="one-time-code"
                    placeholder={t('login.totp.codePlaceholder')}
                  />
                </FormItem>
              )}
              <Button
                block
                variant="solid"
                type="submit"
                loading={submitting}
                disabled={
                  submitting ||
                  (!needsCode && (!identifier.trim() || !password)) ||
                  (needsCode && code.trim().length !== 6)
                }
              >
                {submitting
                  ? t('login.admin.submitting')
                  : needsCode
                    ? t('login.totp.submit')
                    : t('login.admin.submit')}
              </Button>
            </FormContainer>
          </form>

          <div className="mt-6 flex flex-col items-center gap-2 text-sm">
            {needsCode ? (
              <button
                type="button"
                onClick={() => {
                  setNeedsCode(false)
                  setError(null)
                  setCode('')
                }}
                className="text-fg-subtle transition hover:text-fg"
              >
                {t('login.totp.back')}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => goAdmin(false)}
                className="text-fg-subtle transition hover:text-fg"
              >
                {t('login.admin.back')}
              </button>
            )}
          </div>
        </>
      ) : sentTo ? (
        /* ---- Confirmation screen (+ resend with live cooldown) ---- */
        <>
          <AuthHeading
            title={t('login.sent.title')}
            subtitle={t('login.sent.body')}
          />
          <div className="mb-4 rounded-lg border border-border bg-surface-raised px-3 py-2.5 text-center text-sm font-medium text-fg">
            {sentTo}
          </div>
          <p className="mb-1 text-sm text-fg-muted">{t('login.sent.hint')}</p>
          <p className="mb-6 text-xs text-fg-subtle">{t('login.sent.spam')}</p>

          {error && (
            <Alert showIcon type="danger" className="mb-4">
              {error}
            </Alert>
          )}

          <Button
            block
            variant="solid"
            disabled={cooldown > 0 || submitting}
            onClick={() => void sendMagic(sentTo)}
          >
            {cooldown > 0
              ? t('login.sent.resendIn', { seconds: cooldown })
              : t('login.sent.resend')}
          </Button>
          <Button
            block
            className="mt-3"
            onClick={() => {
              setSentTo(null)
              setError(null)
            }}
          >
            {t('login.sent.back')}
          </Button>
        </>
      ) : (
        /* ---- Magic-link request (default) ---- */
        <>
          <AuthHeading title={t('login.title')} subtitle={t('login.subtitle')} />

          {error && (
            <Alert showIcon type="danger" className="mb-4">
              {error}
            </Alert>
          )}

          <form onSubmit={onMagicSubmit}>
            <FormContainer>
              <FormItem label={t('login.emailLabel')}>
                <Input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoFocus
                  autoComplete="email"
                  placeholder={t('login.emailPlaceholder')}
                />
              </FormItem>
              <Button
                block
                variant="solid"
                type="submit"
                loading={submitting}
                disabled={submitting || !email.trim()}
              >
                {submitting ? t('login.submitting') : t('login.submit')}
              </Button>
            </FormContainer>
          </form>

          {allowSignup && (
            <p className="mt-6 text-center text-sm text-fg-subtle">
              {t('login.noAccount')}{' '}
              <Link
                to="/signup"
                className="font-medium text-primary-500 transition hover:text-primary-600"
              >
                {t('login.createAccount')}
              </Link>
            </p>
          )}

          <div className="mt-6 flex items-center justify-center gap-3 text-sm text-fg-subtle">
            <button
              type="button"
              onClick={() => goAdmin(true)}
              className="transition hover:text-fg"
            >
              {t('login.adminAccess')}
            </button>
          </div>
        </>
      )}
    </AuthShell>
  )
}
