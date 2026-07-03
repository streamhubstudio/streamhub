/**
 * Signup + minimal onboarding — public route /signup.
 *
 * Only reachable when the deployment enables public self-signup
 * (GET /auth/config → allowSignup; STREAMHUB_ALLOW_SIGNUP env flag). When the
 * flag is off the page explains that access is invite-only and links back to
 * the login. The flow is deliberately simple:
 *
 *   1. Form: email + password (+ confirm) + workspace/tenant name (the
 *      "choose your team name" onboarding step). POST /auth/signup creates the
 *      user + their tenant + owner membership and adopts the session JWT.
 *   2. Welcome: a short "you're in" screen offering to create the first app
 *      (→ /apps) or jump straight to the dashboard.
 */
import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { useAuth } from '@/auth/useAuth'
import { api, ApiRequestError } from '@/api'
import { validateSignup } from '@/lib/authFlows'
import { AuthShell, AuthHeading } from '@/components/AuthShell'
import { PasswordInput } from '@/components/PasswordInput'
import { Alert, Button, FormContainer, FormItem, Input, Spinner } from '@/ui'

type Step = 'form' | 'welcome'

export default function Signup() {
  const { signup } = useAuth()
  const { t } = useTranslation('auth')
  const navigate = useNavigate()

  const authConfig = useQuery({
    queryKey: ['auth-config'],
    queryFn: ({ signal }) => api.auth.config(signal),
    staleTime: 5 * 60_000,
    retry: false,
  })

  const [step, setStep] = useState<Step>('form')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [teamName, setTeamName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)

    const problem = validateSignup({ email, password, confirm })
    if (problem) {
      setError(t(`signup.errors.${problem}`))
      return
    }

    setSubmitting(true)
    try {
      await signup(email.trim(), password, teamName.trim() || undefined)
      setStep('welcome')
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 403) {
        setError(t('signup.errors.disabled'))
      } else if (err instanceof ApiRequestError && err.status === 400) {
        setError(t('signup.errors.emailTaken'))
      } else {
        setError(t('signup.errors.failed'))
      }
    } finally {
      setSubmitting(false)
    }
  }

  // --- capability gate -------------------------------------------------------
  if (authConfig.isLoading) {
    return (
      <AuthShell>
        <div className="flex items-center gap-3">
          <Spinner size={24} />
          <span className="text-sm text-fg-muted">{t('signup.loading')}</span>
        </div>
      </AuthShell>
    )
  }

  if (!authConfig.data?.allowSignup) {
    return (
      <AuthShell>
        <AuthHeading
          title={t('signup.disabled.title')}
          subtitle={t('signup.disabled.body')}
        />
        <Button block variant="solid" onClick={() => navigate('/login')}>
          {t('signup.disabled.toLogin')}
        </Button>
      </AuthShell>
    )
  }

  // --- step 2: welcome / onboarding ------------------------------------------
  if (step === 'welcome') {
    return (
      <AuthShell>
        <AuthHeading
          title={t('signup.welcome.title')}
          subtitle={t('signup.welcome.body', {
            team: teamName.trim() || email.trim(),
          })}
        />
        <ol className="mb-6 list-inside list-decimal space-y-1 text-sm text-fg-muted">
          <li>{t('signup.welcome.step1')}</li>
          <li>{t('signup.welcome.step2')}</li>
          <li>{t('signup.welcome.step3')}</li>
        </ol>
        <Button block variant="solid" onClick={() => navigate('/apps')}>
          {t('signup.welcome.createApp')}
        </Button>
        <Button block className="mt-3" onClick={() => navigate('/')}>
          {t('signup.welcome.toDashboard')}
        </Button>
      </AuthShell>
    )
  }

  // --- step 1: the form -------------------------------------------------------
  return (
    <AuthShell>
      <AuthHeading title={t('signup.title')} subtitle={t('signup.subtitle')} />

      {error && (
        <Alert showIcon type="danger" className="mb-4">
          {error}
        </Alert>
      )}

      <form onSubmit={onSubmit}>
        <FormContainer>
          <FormItem label={t('signup.emailLabel')}>
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoFocus
              autoComplete="email"
              placeholder={t('login.emailPlaceholder')}
            />
          </FormItem>
          <FormItem label={t('signup.passwordLabel')}>
            <PasswordInput
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
            />
          </FormItem>
          <FormItem label={t('signup.confirmLabel')}>
            <PasswordInput
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
            />
          </FormItem>
          <FormItem
            label={t('signup.teamNameLabel')}
            extra={
              <span className="text-xs text-fg-subtle">
                {t('signup.teamNameHint')}
              </span>
            }
          >
            <Input
              type="text"
              value={teamName}
              onChange={(e) => setTeamName(e.target.value)}
              placeholder={t('signup.teamNamePlaceholder')}
            />
          </FormItem>
          <Button
            block
            variant="solid"
            type="submit"
            loading={submitting}
            disabled={submitting || !email.trim() || !password || !confirm}
          >
            {submitting ? t('signup.submitting') : t('signup.submit')}
          </Button>
        </FormContainer>
      </form>

      <p className="mt-6 text-center text-sm text-fg-subtle">
        {t('signup.hasAccount')}{' '}
        <Link
          to="/login"
          className="font-medium text-primary-500 transition hover:text-primary-600"
        >
          {t('signup.toLogin')}
        </Link>
      </p>
    </AuthShell>
  )
}
