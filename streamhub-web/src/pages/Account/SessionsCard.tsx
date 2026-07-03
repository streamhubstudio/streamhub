/**
 * Active sessions ("Mi cuenta" → Seguridad): the caller's live login sessions,
 * with the ability to close any of them from here.
 *
 *  - GET /auth/sessions lists each session (IP, sign-in date, `current` flag).
 *  - DELETE /auth/sessions/:id revokes one; revoking the CURRENT session signs
 *    this device out (we call logout()).
 *  - DELETE /auth/sessions revokes every OTHER session, keeping this one.
 *
 * Every destructive action goes through a confirmation dialog.
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type SessionInfo } from '@/api'
import { Alert, Button as UiButton, Dialog } from '@/ui'
import { useAuth } from '@/auth/useAuth'
import {
  Button,
  Card,
  ErrorBanner,
  Loading,
  SectionTitle,
  errMessage,
} from './ui'

/** Localized "medium date + short time" (falls back to a dash). */
function formatDate(iso: string | null, lng: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  try {
    return d.toLocaleString(lng, { dateStyle: 'medium', timeStyle: 'short' })
  } catch {
    return d.toLocaleString()
  }
}

type Confirm =
  | { kind: 'one'; session: SessionInfo }
  | { kind: 'others' }
  | null

export function SessionsCard() {
  const { t, i18n } = useTranslation('account')
  const qc = useQueryClient()
  const { logout } = useAuth()

  const sessions = useQuery({
    queryKey: ['account-sessions'],
    queryFn: ({ signal }) => api.account.sessions(signal),
  })

  const [confirm, setConfirm] = useState<Confirm>(null)

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ['account-sessions'] })

  const revokeOne = useMutation({
    mutationFn: (id: string) => api.account.revokeSession(id),
    onSuccess: (res) => {
      setConfirm(null)
      // Revoking the current session ends THIS device's session.
      if (res.current) logout()
      else void invalidate()
    },
  })

  const revokeOthers = useMutation({
    mutationFn: () => api.account.revokeOtherSessions(),
    onSuccess: () => {
      setConfirm(null)
      void invalidate()
    },
  })

  const list = sessions.data ?? []
  const others = list.filter((s) => !s.current).length
  const busy = revokeOne.isPending || revokeOthers.isPending

  return (
    <Card>
      <SectionTitle
        title={t('sessions.title')}
        subtitle={t('sessions.subtitle')}
        right={
          others > 0 ? (
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => setConfirm({ kind: 'others' })}
            >
              {t('sessions.signOutOthers')}
            </Button>
          ) : undefined
        }
      />

      {sessions.isLoading ? (
        <Loading label={t('sessions.loading')} />
      ) : sessions.isError ? (
        <ErrorBanner
          message={errMessage(sessions.error, t('sessions.loadError'))}
        />
      ) : list.length === 0 ? (
        <p className="text-sm text-slate-500">{t('sessions.empty')}</p>
      ) : (
        <ul className="divide-y divide-gray-200 dark:divide-gray-700">
          {list.map((s) => (
            <li
              key={s.id}
              className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm text-fg">
                    {s.ip || t('sessions.unknownIp')}
                  </span>
                  {s.current && (
                    <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-400">
                      {t('sessions.thisDevice')}
                    </span>
                  )}
                </div>
                <div className="mt-0.5 text-xs text-slate-400">
                  {t('sessions.signedIn')} {formatDate(s.createdAt, i18n.language)}
                </div>
                {s.userAgent && (
                  <div className="mt-0.5 max-w-[36rem] truncate text-[11px] text-slate-500">
                    {s.userAgent}
                  </div>
                )}
              </div>
              <Button
                variant="danger"
                disabled={busy}
                onClick={() => setConfirm({ kind: 'one', session: s })}
              >
                {t('sessions.signOut')}
              </Button>
            </li>
          ))}
        </ul>
      )}

      {(revokeOne.isError || revokeOthers.isError) && (
        <div className="mt-3">
          <ErrorBanner
            message={errMessage(
              revokeOne.error ?? revokeOthers.error,
              t('sessions.revokeError'),
            )}
          />
        </div>
      )}

      {confirm && (
        <Dialog
          isOpen
          width={440}
          closable={false}
          onClose={() => !busy && setConfirm(null)}
          onRequestClose={() => !busy && setConfirm(null)}
        >
          <h5 className="mb-2 text-lg font-semibold text-gray-900 dark:text-gray-100">
            {confirm.kind === 'others'
              ? t('sessions.confirmOthersTitle')
              : t('sessions.confirmOneTitle')}
          </h5>
          <p className="mb-4 text-sm text-fg-muted">
            {confirm.kind === 'others'
              ? t('sessions.confirmOthersBody')
              : confirm.session.current
                ? t('sessions.confirmCurrentBody')
                : t('sessions.confirmOneBody')}
          </p>
          {(revokeOne.isError || revokeOthers.isError) && (
            <Alert type="danger" showIcon className="mb-4">
              {errMessage(
                revokeOne.error ?? revokeOthers.error,
                t('sessions.revokeError'),
              )}
            </Alert>
          )}
          <div className="flex items-center justify-end gap-2">
            <UiButton
              size="sm"
              variant="default"
              disabled={busy}
              onClick={() => setConfirm(null)}
            >
              {t('sessions.cancel')}
            </UiButton>
            <UiButton
              size="sm"
              variant="twoTone"
              color="red-600"
              loading={busy}
              onClick={() => {
                if (confirm.kind === 'others') revokeOthers.mutate()
                else revokeOne.mutate(confirm.session.id)
              }}
            >
              {confirm.kind === 'others'
                ? t('sessions.signOutOthers')
                : t('sessions.signOut')}
            </UiButton>
          </div>
        </Dialog>
      )}
    </Card>
  )
}
