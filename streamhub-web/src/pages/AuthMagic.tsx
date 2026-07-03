/**
 * Magic-link verification — public route /auth/magic?token=…
 *
 * Reads ?token= from the emailed link, POSTs it to /auth/magic/verify, stores
 * the returned session JWT, and redirects to the dashboard. Invalid/expired
 * tokens surface a clear message with a "request another link" action.
 *
 * 2FA: when the account has TOTP enabled the backend answers 401
 * `totp_required` WITHOUT burning the link — a code form appears and the same
 * token is re-submitted together with the 6-digit code.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/auth/useAuth'
import { isTotpInvalid, isTotpRequired } from '@/lib/authFlows'
import { AuthShell, AuthHeading } from '@/components/AuthShell'
import { Alert, Button, FormContainer, FormItem, Input, Spinner } from '@/ui'

type Status = 'verifying' | 'totp' | 'success' | 'error'

export default function AuthMagic() {
  const { verifyMagic } = useAuth()
  const { t } = useTranslation('auth')
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const token = params.get('token')

  const [status, setStatus] = useState<Status>('verifying')
  const [errorMsg, setErrorMsg] = useState<string>('')
  const [code, setCode] = useState('')
  const [codeError, setCodeError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  // StrictMode double-invokes effects in dev; guard so we verify a token once.
  const ran = useRef(false)

  useEffect(() => {
    if (ran.current) return
    ran.current = true

    if (!token) {
      setErrorMsg(t('verify.missingToken'))
      setStatus('error')
      return
    }

    let active = true
    void (async () => {
      try {
        await verifyMagic(token)
        if (!active) return
        setStatus('success')
        navigate('/', { replace: true })
      } catch (err) {
        if (!active) return
        if (isTotpRequired(err)) {
          // The link is still valid — ask for the authenticator code.
          setStatus('totp')
          return
        }
        setErrorMsg(t('verify.errorExpired'))
        setStatus('error')
      }
    })()
    return () => {
      active = false
    }
  }, [token, verifyMagic, navigate, t])

  async function onCodeSubmit(e: FormEvent) {
    e.preventDefault()
    if (!token) return
    setCodeError(null)
    setSubmitting(true)
    try {
      await verifyMagic(token, code.trim())
      setStatus('success')
      navigate('/', { replace: true })
    } catch (err) {
      if (isTotpInvalid(err) || isTotpRequired(err)) {
        setCodeError(t('verify.totp.errorInvalid'))
      } else {
        setErrorMsg(t('verify.errorExpired'))
        setStatus('error')
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AuthShell>
      {status === 'error' ? (
        <>
          <AuthHeading title={t('verify.errorTitle')} subtitle={errorMsg} />
          <Button block variant="solid" onClick={() => navigate('/login')}>
            {t('verify.requestAnother')}
          </Button>
        </>
      ) : status === 'totp' ? (
        <>
          <AuthHeading
            title={t('verify.totp.title')}
            subtitle={t('verify.totp.subtitle')}
          />
          {codeError && (
            <Alert showIcon type="danger" className="mb-4">
              {codeError}
            </Alert>
          )}
          <form onSubmit={onCodeSubmit}>
            <FormContainer>
              <FormItem label={t('verify.totp.codeLabel')}>
                <Input
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                  autoFocus
                  autoComplete="one-time-code"
                  placeholder={t('verify.totp.codePlaceholder')}
                />
              </FormItem>
              <Button
                block
                variant="solid"
                type="submit"
                loading={submitting}
                disabled={submitting || code.trim().length !== 6}
              >
                {t('verify.totp.submit')}
              </Button>
            </FormContainer>
          </form>
        </>
      ) : (
        <div className="flex items-center gap-3">
          <Spinner size={24} />
          <div>
            <h3 className="text-xl font-bold text-fg">
              {status === 'success'
                ? t('verify.successTitle')
                : t('verify.verifying')}
            </h3>
            {status === 'success' && (
              <p className="text-sm text-fg-muted">{t('verify.success')}</p>
            )}
          </div>
        </div>
      )}
    </AuthShell>
  )
}
