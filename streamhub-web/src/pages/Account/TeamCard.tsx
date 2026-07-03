/**
 * Team ("Mi cuenta" → Equipo) — everything about MY tenant in one place:
 *  - tenant identity + quota usage (GET /teams/mine — self-scoped, the backend
 *    resolves the tenant from the session, never from a param),
 *  - members list (same call),
 *  - email invitations (owner only): invite form → POST /tenant/invites, the
 *    pending list → GET /tenant/invites, revoke → DELETE /tenant/invites/:id.
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type TeamMember, type TenantRole } from '@/api'
import {
  Button,
  Card,
  Empty,
  ErrorBanner,
  Field,
  Loading,
  RoleBadge,
  SectionTitle,
  Select,
  TextInput,
  UsageBar,
  errMessage,
} from './ui'

const ROLE_VALUES: TenantRole[] = ['owner', 'editor', 'viewer']

export function TeamCard({
  canManage,
  selfId,
}: {
  canManage: boolean
  selfId?: string
}) {
  const { t } = useTranslation('account')
  const qc = useQueryClient()

  const mine = useQuery({
    queryKey: ['team-mine'],
    queryFn: ({ signal }) => api.teams.mine(signal),
  })
  const invites = useQuery({
    queryKey: ['tenant-invites'],
    queryFn: ({ signal }) => api.invites.list(signal),
    enabled: canManage,
  })

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['team-mine'] })
    void qc.invalidateQueries({ queryKey: ['tenant-invites'] })
  }

  const [email, setEmail] = useState('')
  const [role, setRole] = useState<TenantRole>('viewer')

  const invite = useMutation({
    mutationFn: () => api.invites.create({ email: email.trim(), role }),
    onSuccess: () => {
      setEmail('')
      setRole('viewer')
      invalidate()
    },
  })

  const revoke = useMutation({
    mutationFn: (userId: string) => api.invites.revoke(userId),
    onSuccess: invalidate,
  })

  if (mine.isLoading) {
    return (
      <Card>
        <Loading label={t('members.loading')} />
      </Card>
    )
  }
  if (mine.isError || !mine.data) {
    return (
      <Card>
        <ErrorBanner message={errMessage(mine.error, t('members.loadError'))} />
      </Card>
    )
  }

  const { team, members, usage } = mine.data
  const pending = invites.data ?? []
  const active = members.filter((m) => m.status !== 'pending')

  return (
    <div className="space-y-5">
      {/* ---- Tenant + usage ---- */}
      <Card>
        <SectionTitle
          title={t('overview.tenantTitle')}
          subtitle={t('overview.tenantSubtitle')}
        />
        <dl className="mb-5 grid gap-4 sm:grid-cols-3">
          <div>
            <dt className="text-[11px] text-slate-500">{t('overview.name')}</dt>
            <dd className="text-sm text-fg">{team?.name ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-[11px] text-slate-500">{t('overview.plan')}</dt>
            <dd className="text-sm text-fg">{team?.plan ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-[11px] text-slate-500">{t('overview.id')}</dt>
            <dd className="truncate font-mono text-xs text-primary-500">
              {team?.id ?? '—'}
            </dd>
          </div>
        </dl>
        <div className="space-y-4">
          {usage?.apps && <UsageBar label={t('metrics.apps')} {...usage.apps} />}
          {usage?.concurrentStreams && (
            <UsageBar
              label={t('metrics.concurrentStreams')}
              {...usage.concurrentStreams}
            />
          )}
          {usage?.recordingMinutes && (
            <UsageBar
              label={t('metrics.recordingMinutes')}
              {...usage.recordingMinutes}
              unit="min"
            />
          )}
          {usage?.egressGb && (
            <UsageBar label={t('metrics.egress')} {...usage.egressGb} unit="GB" />
          )}
          {usage?.storageGb && (
            <UsageBar label={t('metrics.storage')} {...usage.storageGb} unit="GB" />
          )}
        </div>
      </Card>

      {/* ---- Members + invitations ---- */}
      <Card>
        <SectionTitle
          title={t('members.title')}
          subtitle={
            canManage ? t('members.subtitleManage') : t('members.subtitleReadonly')
          }
        />

        {canManage && (
          <div className="mb-5 rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-600 dark:bg-gray-700/40">
            <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-end">
              <Field label={t('members.emailLabel')}>
                <TextInput
                  type="email"
                  value={email}
                  placeholder={t('members.emailPlaceholder')}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </Field>
              <Field label={t('members.roleLabel')}>
                <Select
                  value={role}
                  onChange={(e) => setRole(e.target.value as TenantRole)}
                >
                  {ROLE_VALUES.map((value) => (
                    <option key={value} value={value}>
                      {t(`roles.${value}`)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Button
                variant="accent"
                disabled={invite.isPending || !email.trim()}
                onClick={() => invite.mutate()}
                className="h-9"
              >
                {invite.isPending ? t('members.inviting') : t('members.invite')}
              </Button>
            </div>
            {invite.isError && (
              <div className="mt-3">
                <ErrorBanner
                  message={errMessage(invite.error, t('members.inviteError'))}
                />
              </div>
            )}
            {invite.isSuccess && (
              <p className="mt-2 text-xs text-emerald-400">
                {invite.data?.emailSent
                  ? t('members.inviteSuccess')
                  : t('members.inviteCreatedNoEmail')}
              </p>
            )}
          </div>
        )}

        {active.length === 0 ? (
          <Empty label={t('members.empty')} />
        ) : (
          <ul className="divide-y divide-gray-200 dark:divide-gray-700">
            {active.map((m: TeamMember) => {
              const isSelf = selfId && m.userId === selfId
              return (
                <li
                  key={m.userId}
                  className="flex flex-wrap items-center justify-between gap-3 py-3"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm text-fg">
                        {m.name || m.email || m.userId}
                      </span>
                      {isSelf && (
                        <span className="text-[10px] text-slate-500">
                          {t('members.you')}
                        </span>
                      )}
                    </div>
                    {m.email && (
                      <div className="truncate text-[11px] text-slate-500">
                        {m.email}
                      </div>
                    )}
                  </div>
                  <RoleBadge role={m.isSuperadmin ? 'superadmin' : m.role} />
                </li>
              )
            })}
          </ul>
        )}
      </Card>

      {/* ---- Pending invitations (owner only) ---- */}
      {canManage && (
        <Card>
          <SectionTitle
            title={t('invites.title')}
            subtitle={t('invites.subtitle')}
          />
          {invites.isLoading ? (
            <Loading label={t('invites.loading')} />
          ) : invites.isError ? (
            <ErrorBanner
              message={errMessage(invites.error, t('invites.loadError'))}
            />
          ) : pending.length === 0 ? (
            <Empty label={t('invites.empty')} />
          ) : (
            <ul className="divide-y divide-gray-200 dark:divide-gray-700">
              {pending.map((i) => (
                <li
                  key={i.userId}
                  className="flex flex-wrap items-center justify-between gap-3 py-3"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm text-fg">{i.email}</span>
                      <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] text-amber-400">
                        {t('members.invitedBadge')}
                      </span>
                    </div>
                    <div className="text-[11px] text-slate-500">
                      {t('invites.sentAt', { date: i.invitedAt })}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <RoleBadge role={i.role} />
                    <Button
                      variant="danger"
                      disabled={revoke.isPending}
                      onClick={() => {
                        if (window.confirm(t('invites.revokeConfirm', { email: i.email }))) {
                          revoke.mutate(i.userId)
                        }
                      }}
                    >
                      {t('invites.revoke')}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {revoke.isError && (
            <div className="mt-3">
              <ErrorBanner
                message={errMessage(revoke.error, t('invites.revokeError'))}
              />
            </div>
          )}
        </Card>
      )}
    </div>
  )
}
