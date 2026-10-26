/**
 * "Mi cuenta" → Seguridad → SMTP override (owner item 29).
 *
 * Mail I initiate (my own magic-link sign-in, an invite I send as inviter)
 * uses this when enabled, else the app SMTP, else the global default —
 * GET/PUT /account/smtp (password masked; stored ENCRYPTED, never plaintext).
 * "Send test" (POST /account/smtp/test) bypasses the enabled gate so the
 * settings can be verified before flipping the switch, mirroring the
 * per-app SmtpCard in AppDetail's Integraciones tab.
 */
import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '@/api'
import {
  Button,
  Card,
  ErrorBanner,
  Field,
  Loading,
  SectionTitle,
  TextInput,
  Toggle,
  errMessage,
} from './ui'

export function SmtpCard() {
  const { t } = useTranslation('account')
  const qc = useQueryClient()
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['account-smtp'],
    queryFn: ({ signal }) => api.account.getSmtp(signal),
  })

  const [enabled, setEnabled] = useState(false)
  const [host, setHost] = useState('')
  const [port, setPort] = useState('587')
  const [user, setUser] = useState('')
  // Secret: never prefilled. Sent only when a new value is typed.
  const [pass, setPass] = useState('')
  const [from, setFrom] = useState('')
  const [testTo, setTestTo] = useState('')

  useEffect(() => {
    if (!data) return
    setEnabled(Boolean(data.enabled))
    setHost(data.host ?? '')
    setPort(String(data.port ?? 587))
    setUser(data.user ?? '')
    setPass('')
    setFrom(data.from ?? '')
  }, [data])

  const save = useMutation({
    mutationFn: () =>
      api.account.putSmtp({
        enabled,
        host: host.trim(),
        port: Number(port) || 587,
        user: user.trim(),
        from: from.trim(),
        ...(pass.trim() ? { pass: pass.trim() } : {}),
      }),
    onSuccess: () => {
      setPass('')
      qc.invalidateQueries({ queryKey: ['account-smtp'] })
    },
  })

  const test = useMutation({
    mutationFn: () => api.account.testSmtp({ to: testTo.trim() }),
  })

  if (isLoading) {
    return (
      <Card>
        <Loading label={t('security.smtp.loading')} />
      </Card>
    )
  }
  if (isError) {
    return (
      <Card>
        <ErrorBanner message={errMessage(error, t('security.smtp.loadError'))} />
      </Card>
    )
  }

  const dirty =
    enabled !== Boolean(data?.enabled) ||
    host !== (data?.host ?? '') ||
    port !== String(data?.port ?? 587) ||
    user !== (data?.user ?? '') ||
    from !== (data?.from ?? '') ||
    pass.trim() !== ''

  return (
    <Card>
      <SectionTitle
        title={t('security.smtp.title')}
        subtitle={t('security.smtp.subtitle')}
      />
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-4 rounded-lg border border-navy-600 bg-navy-700/40 px-4 py-3">
          <div>
            <div className="text-sm text-slate-100">
              {t('security.smtp.enabledLabel')}
            </div>
            <div className="mt-0.5 text-[11px] text-slate-500">
              {t('security.smtp.enabledHint')}
            </div>
          </div>
          <Toggle checked={enabled} onChange={setEnabled} />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('security.smtp.hostLabel')}>
            <TextInput
              value={host}
              placeholder="smtp.example.com"
              onChange={(e) => setHost(e.target.value)}
            />
          </Field>
          <Field
            label={t('security.smtp.portLabel')}
            hint={t('security.smtp.portHint')}
          >
            <TextInput
              type="number"
              value={port}
              onChange={(e) => setPort(e.target.value)}
            />
          </Field>
          <Field label={t('security.smtp.userLabel')}>
            <TextInput
              value={user}
              placeholder="me@example.com"
              onChange={(e) => setUser(e.target.value)}
            />
          </Field>
          <Field
            label={t('security.smtp.passLabel')}
            hint={data?.hasPass ? t('security.smtp.storedHint') : undefined}
          >
            <TextInput
              type="password"
              autoComplete="off"
              value={pass}
              placeholder={data?.pass || '••••••••'}
              onChange={(e) => setPass(e.target.value)}
            />
          </Field>
          <Field
            label={t('security.smtp.fromLabel')}
            hint={t('security.smtp.fromHint')}
          >
            <TextInput
              value={from}
              placeholder="Alice <me@example.com>"
              onChange={(e) => setFrom(e.target.value)}
            />
          </Field>
        </div>

        {save.isError && (
          <ErrorBanner
            message={errMessage(save.error, t('security.smtp.saveError'))}
          />
        )}
        <div className="flex items-center gap-3">
          <Button
            variant="accent"
            disabled={save.isPending || !dirty}
            onClick={() => save.mutate()}
          >
            {save.isPending ? t('security.smtp.saving') : t('security.smtp.save')}
          </Button>
          {save.isSuccess && !save.isPending && (
            <span className="text-xs text-success">{t('security.smtp.saved')}</span>
          )}
        </div>

        {/* Test send — probes the SAVED config (bypasses the enabled gate
            server-side). Disabled while there are unsaved changes so it never
            silently tests stale settings. */}
        <div className="rounded-lg border border-navy-600 bg-navy-700/40 p-4">
          <div className="text-sm text-slate-100">{t('security.smtp.testLabel')}</div>
          <div className="mt-0.5 text-[11px] text-slate-500">
            {dirty ? t('security.smtp.testDirtyHint') : t('security.smtp.testHint')}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <div className="min-w-[16rem] flex-1">
              <TextInput
                value={testTo}
                placeholder="you@example.com"
                aria-label={t('security.smtp.testLabel')}
                onChange={(e) => setTestTo(e.target.value)}
              />
            </div>
            <Button
              variant="ghost"
              disabled={test.isPending || !testTo.trim() || dirty}
              onClick={() => test.mutate()}
            >
              {test.isPending ? t('security.smtp.testing') : t('security.smtp.testSend')}
            </Button>
          </div>
          {test.isSuccess && test.data.ok && (
            <p className="mt-2 text-xs text-success">{t('security.smtp.testSent')}</p>
          )}
          {test.isSuccess && !test.data.ok && (
            <p className="mt-2 text-xs text-danger">
              {test.data.skipped
                ? t('security.smtp.testNotConfigured')
                : t('security.smtp.testFailed')}
            </p>
          )}
          {test.isError && (
            <ErrorBanner
              message={errMessage(test.error, t('security.smtp.testFailed'))}
            />
          )}
        </div>
      </div>
    </Card>
  )
}
