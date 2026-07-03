/**
 * Superadmin: every tenant + quota management. Lists GET /tenants, lets the
 * platform owner pick one (to inspect its usage/members in the other tabs) and
 * raise its plan/limits via PATCH /tenants/:id/quotas.
 */
import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type Quotas, type Tenant } from '@/api'
import {
  Button,
  Card,
  Empty,
  ErrorBanner,
  Field,
  Loading,
  SectionTitle,
  TextInput,
  errMessage,
} from './ui'

const QUOTA_FIELDS: { key: keyof Quotas; labelKey: string; unit?: string }[] = [
  { key: 'maxApps', labelKey: 'platform.quotaFields.apps' },
  { key: 'maxConcurrentStreams', labelKey: 'platform.quotaFields.concurrentStreams' },
  { key: 'maxRecordingMinutesMonth', labelKey: 'platform.quotaFields.recordingMinutes', unit: 'min' },
  { key: 'maxEgressGbMonth', labelKey: 'platform.quotaFields.egress', unit: 'GB' },
  { key: 'maxStorageGb', labelKey: 'platform.quotaFields.storage', unit: 'GB' },
]

function QuotaEditor({ tenant }: { tenant: Tenant }) {
  const { t } = useTranslation('account')
  const qc = useQueryClient()
  const [plan, setPlan] = useState(tenant.plan)
  const [quotas, setQuotas] = useState<Quotas>(tenant.quotas)

  useEffect(() => {
    setPlan(tenant.plan)
    setQuotas(tenant.quotas)
  }, [tenant])

  const save = useMutation({
    mutationFn: () => api.tenants.updateQuotas(tenant.id, { plan, ...quotas }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tenants'] })
      qc.invalidateQueries({ queryKey: ['tenant', tenant.id] })
      qc.invalidateQueries({ queryKey: ['tenant-usage', tenant.id] })
    },
  })

  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-600 dark:bg-gray-700/40">
      <div className="mb-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field label={t('platform.plan')}>
          <TextInput value={plan} onChange={(e) => setPlan(e.target.value)} />
        </Field>
        {QUOTA_FIELDS.map((f) => (
          <Field key={f.key} label={t(f.labelKey)} hint={f.unit}>
            <TextInput
              type="number"
              value={Number.isFinite(quotas[f.key]) ? quotas[f.key] : 0}
              onChange={(e) =>
                setQuotas((q) => ({ ...q, [f.key]: Number(e.target.value) || 0 }))
              }
            />
          </Field>
        ))}
      </div>
      {save.isError && (
        <div className="mb-3">
          <ErrorBanner message={errMessage(save.error, t('platform.saveError'))} />
        </div>
      )}
      <div className="flex items-center gap-3">
        <Button variant="accent" disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? t('platform.saving') : t('platform.saveQuotas')}
        </Button>
        {save.isSuccess && !save.isPending && (
          <span className="text-xs text-emerald-300">{t('platform.saved')}</span>
        )}
      </div>
    </div>
  )
}

export function SuperadminTenants({
  selectedId,
  onSelect,
}: {
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  const { t } = useTranslation('account')
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['tenants'],
    queryFn: ({ signal }) => api.tenants.list(signal),
  })
  const [editing, setEditing] = useState<string | null>(null)

  return (
    <Card>
      <SectionTitle
        title={t('platform.title')}
        subtitle={t('platform.subtitle')}
      />
      {isLoading ? (
        <Loading label={t('platform.loading')} />
      ) : isError ? (
        <ErrorBanner message={errMessage(error, t('platform.loadError'))} />
      ) : (data ?? []).length === 0 ? (
        <Empty label={t('platform.empty')} />
      ) : (
        <ul className="space-y-2">
          {(data ?? []).map((tenant) => {
            const isSel = tenant.id === selectedId
            const isEditing = tenant.id === editing
            return (
              <li
                key={tenant.id}
                className={[
                  'rounded-lg border px-4 py-3 transition',
                  isSel
                    ? 'border-primary-500/40 bg-primary-500/5'
                    : 'border-gray-200 bg-gray-50 dark:border-gray-600 dark:bg-gray-700/30',
                ].join(' ')}
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm text-fg">{tenant.name}</span>
                      <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] text-gray-600 dark:bg-gray-600/60 dark:text-gray-100">
                        {tenant.plan}
                      </span>
                      {typeof tenant.appCount === 'number' && (
                        <span className="text-[10px] text-slate-500">
                          {t('platform.appCount', { count: tenant.appCount })}
                        </span>
                      )}
                    </div>
                    <div className="truncate font-mono text-[11px] text-primary-500">{tenant.id}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant={isSel ? 'accent' : 'ghost'}
                      onClick={() => onSelect(tenant.id)}
                    >
                      {isSel ? t('platform.selected') : t('platform.select')}
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => setEditing(isEditing ? null : tenant.id)}
                    >
                      {isEditing ? t('common:actions.close') : t('platform.quotas')}
                    </Button>
                  </div>
                </div>
                {isEditing && (
                  <div className="mt-3">
                    <QuotaEditor tenant={tenant} />
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}
