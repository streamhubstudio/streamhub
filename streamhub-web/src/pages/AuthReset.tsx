/**
 * Password reset — public route /auth/reset.
 *
 * Two modes, one component (mirrors the magic-link UX):
 *  - No ?token=  → "request" mode: a single email field →
 *      POST /auth/reset-request → "check your email" confirmation.
 *      (This is where the Login "Forgot your password?" link lands.)
 *  - With ?token= → "set" mode: new-password + confirmation fields →
 *      POST /auth/reset → success → sign in with the new password.
 *      Invalid/expired tokens surface a clear message + a way to request another.
 *
 * Re-skinned to the Elstar SignInCover look (<AuthShell> + Elstar components).
 * The reset logic, modes and validation are unchanged.
 */
import { useState, type FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/auth/useAuth'
import { ApiRequestError } from '@/api'
import { AuthShell, AuthHeading } from '@/components/AuthShell'
import { PasswordInput } from '@/components/PasswordInput'
import { Alert, Button, FormContainer, FormItem, Input } from '@/ui'

const MIN_PASSWORD = 8

export default function AuthReset() {
  const { requestPasswordReset, resetPassword } = useAuth()
  const { t } = useTranslation('auth')
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const token = params.get('token')

  // request mode
  const [email, setEmail] = useState('')
  const [sentTo, setSentTo] = useState<string | null>(null)

  // set mode
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [done, setDone] = useState(false)
  const [expired, setExpired] = useState(false)

  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function onRequestSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    const addr = email.trim()
    try {
      await requestPasswordReset(addr)
      setSentTo(addr)
    } catch {
      setError(t('reset.request.error'))
    } finally {
      setSubmitting(false)
    }
  }

  async function onSetSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (password.length < MIN_PASSWORD) {
      setError(t('reset.set.errorTooShort', { min: MIN_PASSWORD }))
      return
    }
    if (password !== confirm) {
      setError(t('reset.set.errorMismatch'))
      return
    }
    setSubmitting(true)
    try {
      await resetPassword(token as string, password)
      setDone(true)
    } catch (err) {
      // Invalid / expired / consumed token → offer to request another.
      if (
        err instanceof ApiRequestError &&
        [400, 401, 404, 410].includes(err.status)
      ) {
        setExpired(true)
      } else {
        setError(t('reset.set.error'))
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AuthShell>
      {/* ---- SET mode: emailed link with ?token= ---- */}
      {token ? (
        expired ? (
          <>
            <AuthHeading
              title={t('reset.set.expiredTitle')}
              subtitle={t('reset.set.expiredBody')}
            />
            <Button
              block
              variant="solid"
              onClick={() => {
                setExpired(false)
                navigate('/auth/reset')
              }}
            >
              {t('reset.set.requestAnother')}
            </Button>
          </>
        ) : done ? (
          <>
            <AuthHeading
              title={t('reset.set.doneTitle')}
              subtitle={t('reset.set.doneBody')}
            />
            <Button
              block
              variant="solid"
              onClick={() => navigate('/login', { replace: true })}
            >
              {t('reset.set.toLogin')}
            </Button>
          </>
        ) : (
          <>
            <AuthHeading
              title={t('reset.set.title')}
              subtitle={t('reset.set.subtitle')}
            />

            {error && (
              <Alert showIcon type="danger" className="mb-4">
                {error}
              </Alert>
            )}

            <form onSubmit={onSetSubmit}>
              <FormContainer>
                <FormItem label={t('reset.set.passwordLabel')}>
                  <PasswordInput
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoFocus
                    autoComplete="new-password"
                  />
                </FormItem>
                <FormItem label={t('reset.set.confirmLabel')}>
                  <PasswordInput
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    autoComplete="new-password"
                  />
                </FormItem>
                <Button
                  block
                  variant="solid"
                  type="submit"
                  loading={submitting}
                  disabled={submitting || !password || !confirm}
                >
                  {submitting
                    ? t('reset.set.submitting')
                    : t('reset.set.submit')}
                </Button>
              </FormContainer>
            </form>
          </>
        )
      ) : sentTo ? (
        /* ---- REQUEST mode: confirmation ---- */
        <>
          <AuthHeading
            title={t('reset.sent.title')}
            subtitle={t('reset.sent.body')}
          />
          <div className="mb-4 rounded-lg border border-border bg-surface-raised px-3 py-2.5 text-center text-sm font-medium text-fg">
            {sentTo}
          </div>
          <p className="mb-1 text-sm text-fg-muted">{t('reset.sent.hint')}</p>
          <p className="mb-6 text-xs text-fg-subtle">{t('reset.sent.spam')}</p>

          <Button
            block
            variant="solid"
            onClick={() => {
              setError(null)
              void requestPasswordReset(sentTo)
            }}
          >
            {t('reset.sent.resend')}
          </Button>
          <Button block className="mt-3" onClick={() => navigate('/login')}>
            {t('reset.sent.toLogin')}
          </Button>
        </>
      ) : (
        /* ---- REQUEST mode: email form (default) ---- */
        <>
          <AuthHeading
            title={t('reset.request.title')}
            subtitle={t('reset.request.subtitle')}
          />

          {error && (
            <Alert showIcon type="danger" className="mb-4">
              {error}
            </Alert>
          )}

          <form onSubmit={onRequestSubmit}>
            <FormContainer>
              <FormItem label={t('reset.request.emailLabel')}>
                <Input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoFocus
                  autoComplete="email"
                  placeholder={t('reset.request.emailPlaceholder')}
                />
              </FormItem>
              <Button
                block
                variant="solid"
                type="submit"
                loading={submitting}
                disabled={submitting || !email.trim()}
              >
                {submitting
                  ? t('reset.request.submitting')
                  : t('reset.request.submit')}
              </Button>
            </FormContainer>
          </form>

          <div className="mt-6 text-center text-sm">
            <Link
              to="/login"
              className="text-fg-subtle transition hover:text-fg"
            >
              {t('reset.request.back')}
            </Link>
          </div>
        </>
      )}
    </AuthShell>
  )
}
