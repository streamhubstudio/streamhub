/**
 * Security ("Mi cuenta" → Seguridad):
 *  - password change (POST /account/password — requires the current password;
 *    magic-link-born accounts without a known password are pointed at the
 *    emailed reset flow instead),
 *  - 2FA (TOTP): enrol via POST /account/2fa/setup (QR data URI rendered
 *    server-side + manual secret) → confirm a live code (enable) — or disable
 *    with a live code when already active. The break-glass admin password is
 *    env-managed, so that block is hidden for the admin account.
 */
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type TwoFaSetup } from '@/api'
import {
  Button,
  Card,
  ErrorBanner,
  Field,
  Loading,
  SectionTitle,
  TextInput,
  errMessage,
} from './ui'

function CodeInput({
  value,
  onChange,
  placeholder,
}: {
  value: string
  onChange: (v: string) => void
  placeholder: string
}) {
  return (
    <TextInput
      type="text"
      inputMode="numeric"
      maxLength={6}
      value={value}
      placeholder={placeholder}
      autoComplete="one-time-code"
      onChange={(e) => onChange(e.target.value.replace(/\D/g, ''))}
      className="max-w-[10rem] text-center font-mono tracking-[0.3em]"
    />
  )
}

export function SecurityCard() {
  const { t } = useTranslation('account')
  const qc = useQueryClient()

  const account = useQuery({
    queryKey: ['account'],
    queryFn: ({ signal }) => api.account.get(signal),
  })

  // --- password change -------------------------------------------------------
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [pwError, setPwError] = useState<string | null>(null)

  const changePassword = useMutation({
    mutationFn: () => api.account.changePassword({ currentPassword, newPassword }),
    onSuccess: () => {
      setCurrentPassword('')
      setNewPassword('')
      setConfirm('')
    },
  })

  function onChangePassword() {
    setPwError(null)
    if (newPassword.length < 8) {
      setPwError(t('security.password.errorTooShort', { min: 8 }))
      return
    }
    if (newPassword !== confirm) {
      setPwError(t('security.password.errorMismatch'))
      return
    }
    changePassword.mutate()
  }

  // --- 2FA -------------------------------------------------------------------
  const [setup, setSetup] = useState<TwoFaSetup | null>(null)
  const [enableCode, setEnableCode] = useState('')
  const [disableCode, setDisableCode] = useState('')

  const invalidateAccount = () =>
    qc.invalidateQueries({ queryKey: ['account'] })

  const start2fa = useMutation({
    mutationFn: () => api.account.setup2fa(),
    onSuccess: (data) => {
      setSetup(data)
      setEnableCode('')
    },
  })
  const enable2fa = useMutation({
    mutationFn: () => api.account.enable2fa(enableCode.trim()),
    onSuccess: () => {
      setSetup(null)
      setEnableCode('')
      void invalidateAccount()
    },
  })
  const disable2fa = useMutation({
    mutationFn: () => api.account.disable2fa(disableCode.trim()),
    onSuccess: () => {
      setDisableCode('')
      void invalidateAccount()
    },
  })

  if (account.isLoading) {
    return (
      <Card>
        <Loading label={t('profile.loading')} />
      </Card>
    )
  }
  if (account.isError || !account.data) {
    return (
      <Card>
        <ErrorBanner message={errMessage(account.error, t('profile.loadError'))} />
      </Card>
    )
  }

  const { user } = account.data
  const isAdmin = user.id === 'admin'
  const twoFaOn = user.twoFactorEnabled

  return (
    <div className="space-y-5">
      {/* ---- Password ---- */}
      {!isAdmin && (
        <Card>
          <SectionTitle
            title={t('security.password.title')}
            subtitle={
              user.hasPassword
                ? t('security.password.subtitle')
                : t('security.password.noPassword')
            }
          />
          {user.hasPassword ? (
            <>
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label={t('security.password.currentLabel')}>
                  <TextInput
                    type="password"
                    value={currentPassword}
                    autoComplete="current-password"
                    onChange={(e) => setCurrentPassword(e.target.value)}
                  />
                </Field>
                <Field label={t('security.password.newLabel')}>
                  <TextInput
                    type="password"
                    value={newPassword}
                    autoComplete="new-password"
                    onChange={(e) => setNewPassword(e.target.value)}
                  />
                </Field>
                <Field label={t('security.password.confirmLabel')}>
                  <TextInput
                    type="password"
                    value={confirm}
                    autoComplete="new-password"
                    onChange={(e) => setConfirm(e.target.value)}
                  />
                </Field>
              </div>
              <div className="mt-4 flex items-center gap-3">
                <Button
                  variant="accent"
                  disabled={
                    changePassword.isPending ||
                    !currentPassword ||
                    !newPassword ||
                    !confirm
                  }
                  onClick={onChangePassword}
                >
                  {changePassword.isPending
                    ? t('security.password.changing')
                    : t('security.password.change')}
                </Button>
                {changePassword.isSuccess && (
                  <span className="text-xs text-emerald-400">
                    {t('security.password.changed')}
                  </span>
                )}
              </div>
              {(pwError || changePassword.isError) && (
                <div className="mt-3">
                  <ErrorBanner
                    message={
                      pwError ??
                      errMessage(
                        changePassword.error,
                        t('security.password.error'),
                      )
                    }
                  />
                </div>
              )}
            </>
          ) : (
            <Link
              to="/auth/reset"
              className="text-sm text-primary-500 transition hover:text-primary-600"
            >
              {t('security.password.setViaReset')}
            </Link>
          )}
        </Card>
      )}

      {/* ---- 2FA ---- */}
      <Card>
        <SectionTitle
          title={t('security.twofa.title')}
          subtitle={
            twoFaOn
              ? t('security.twofa.subtitleOn')
              : t('security.twofa.subtitleOff')
          }
          right={
            <span
              className={[
                'rounded-full px-2 py-0.5 text-[10px] font-medium',
                twoFaOn
                  ? 'bg-emerald-500/15 text-emerald-400'
                  : 'bg-gray-200 text-gray-600 dark:bg-gray-600/60 dark:text-gray-200',
              ].join(' ')}
            >
              {twoFaOn ? t('security.twofa.on') : t('security.twofa.off')}
            </span>
          }
        />

        {twoFaOn ? (
          /* enabled → disable with a live code */
          <div className="flex flex-wrap items-end gap-3">
            <Field label={t('security.twofa.codeLabel')}>
              <CodeInput
                value={disableCode}
                onChange={setDisableCode}
                placeholder="000000"
              />
            </Field>
            <Button
              variant="danger"
              disabled={disable2fa.isPending || disableCode.trim().length !== 6}
              onClick={() => disable2fa.mutate()}
            >
              {disable2fa.isPending
                ? t('security.twofa.disabling')
                : t('security.twofa.disable')}
            </Button>
            {disable2fa.isError && (
              <div className="w-full">
                <ErrorBanner
                  message={errMessage(
                    disable2fa.error,
                    t('security.twofa.errorCode'),
                  )}
                />
              </div>
            )}
          </div>
        ) : setup ? (
          /* enrolment in progress → QR + secret + confirm code */
          <div className="space-y-4">
            <div className="flex flex-wrap items-start gap-5">
              <img
                src={setup.qrDataUri}
                alt={t('security.twofa.qrAlt')}
                className="h-[180px] w-[180px] rounded-lg border border-gray-200 bg-white p-2 dark:border-gray-600"
              />
              <div className="min-w-0 flex-1 space-y-3">
                <p className="text-sm text-fg-muted">
                  {t('security.twofa.scanHint')}
                </p>
                <div>
                  <div className="text-[11px] text-slate-500">
                    {t('security.twofa.secretLabel')}
                  </div>
                  <code className="break-all font-mono text-xs text-primary-500">
                    {setup.secret}
                  </code>
                </div>
                <div className="flex flex-wrap items-end gap-3">
                  <Field label={t('security.twofa.confirmLabel')}>
                    <CodeInput
                      value={enableCode}
                      onChange={setEnableCode}
                      placeholder="000000"
                    />
                  </Field>
                  <Button
                    variant="accent"
                    disabled={
                      enable2fa.isPending || enableCode.trim().length !== 6
                    }
                    onClick={() => enable2fa.mutate()}
                  >
                    {enable2fa.isPending
                      ? t('security.twofa.enabling')
                      : t('security.twofa.enable')}
                  </Button>
                  <Button variant="ghost" onClick={() => setSetup(null)}>
                    {t('security.twofa.cancel')}
                  </Button>
                </div>
              </div>
            </div>
            {enable2fa.isError && (
              <ErrorBanner
                message={errMessage(
                  enable2fa.error,
                  t('security.twofa.errorCode'),
                )}
              />
            )}
          </div>
        ) : (
          /* disabled → start enrolment */
          <div>
            <Button
              variant="accent"
              disabled={start2fa.isPending}
              onClick={() => start2fa.mutate()}
            >
              {start2fa.isPending
                ? t('security.twofa.starting')
                : t('security.twofa.start')}
            </Button>
            {start2fa.isError && (
              <div className="mt-3">
                <ErrorBanner
                  message={errMessage(
                    start2fa.error,
                    t('security.twofa.errorStart'),
                  )}
                />
              </div>
            )}
          </div>
        )}
      </Card>
    </div>
  )
}
