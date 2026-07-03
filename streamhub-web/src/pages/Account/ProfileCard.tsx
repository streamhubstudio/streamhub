/**
 * Profile ("Mi cuenta") — the signed-in user's own data from GET /account:
 * display name + email (editable via PATCH /account) and the tenant/role the
 * session acts under (read-only). The break-glass admin's email is env-managed
 * (the backend rejects changing it), so the field is disabled for that account.
 */
import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type AccountInfo, type TenantRole } from '@/api'
import {
  Button,
  Card,
  ErrorBanner,
  Field,
  Loading,
  RoleBadge,
  SectionTitle,
  TextInput,
  errMessage,
} from './ui'

export function ProfileCard() {
  const { t } = useTranslation('account')
  const qc = useQueryClient()

  const account = useQuery({
    queryKey: ['account'],
    queryFn: ({ signal }) => api.account.get(signal),
  })

  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [seeded, setSeeded] = useState(false)

  useEffect(() => {
    if (account.data && !seeded) {
      setName(account.data.user.name ?? '')
      setEmail(account.data.user.email ?? '')
      setSeeded(true)
    }
  }, [account.data, seeded])

  const save = useMutation({
    mutationFn: () =>
      api.account.update({
        name,
        ...(isAdmin ? {} : { email: email.trim() }),
      }),
    onSuccess: (data: AccountInfo) => {
      qc.setQueryData(['account'], data)
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
        <ErrorBanner
          message={errMessage(account.error, t('profile.loadError'))}
        />
      </Card>
    )
  }

  const { user, tenant } = account.data
  const isAdmin = user.id === 'admin'
  const dirty =
    name !== (user.name ?? '') || email.trim() !== (user.email ?? '')

  return (
    <div className="space-y-5">
      <Card>
        <SectionTitle
          title={t('profile.title')}
          subtitle={t('profile.subtitle')}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('profile.nameLabel')}>
            <TextInput
              type="text"
              value={name}
              placeholder={t('profile.namePlaceholder')}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field
            label={t('profile.emailLabel')}
            hint={isAdmin ? t('profile.emailAdminHint') : undefined}
          >
            <TextInput
              type="email"
              value={email}
              disabled={isAdmin}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
        </div>
        <div className="mt-4 flex items-center gap-3">
          <Button
            variant="accent"
            disabled={save.isPending || !dirty}
            onClick={() => save.mutate()}
          >
            {save.isPending ? t('profile.saving') : t('profile.save')}
          </Button>
          {save.isSuccess && !dirty && (
            <span className="text-xs text-emerald-400">{t('profile.saved')}</span>
          )}
        </div>
        {save.isError && (
          <div className="mt-3">
            <ErrorBanner message={errMessage(save.error, t('profile.saveError'))} />
          </div>
        )}
      </Card>

      <Card>
        <SectionTitle
          title={t('profile.tenantTitle')}
          subtitle={t('profile.tenantSubtitle')}
        />
        {tenant ? (
          <dl className="grid gap-4 sm:grid-cols-4">
            <div>
              <dt className="text-[11px] text-slate-500">{t('overview.name')}</dt>
              <dd className="text-sm text-fg">{tenant.name}</dd>
            </div>
            <div>
              <dt className="text-[11px] text-slate-500">{t('overview.plan')}</dt>
              <dd className="text-sm text-fg">{tenant.plan || '—'}</dd>
            </div>
            <div>
              <dt className="text-[11px] text-slate-500">{t('profile.roleLabel')}</dt>
              <dd className="mt-0.5">
                <RoleBadge
                  role={
                    (user.isSuperadmin
                      ? 'superadmin'
                      : tenant.role) as TenantRole | 'superadmin'
                  }
                />
              </dd>
            </div>
            <div>
              <dt className="text-[11px] text-slate-500">{t('overview.id')}</dt>
              <dd className="truncate font-mono text-xs text-primary-500">
                {tenant.id}
              </dd>
            </div>
          </dl>
        ) : (
          <p className="text-sm text-slate-500">{t('noTenant.member')}</p>
        )}
      </Card>
    </div>
  )
}
