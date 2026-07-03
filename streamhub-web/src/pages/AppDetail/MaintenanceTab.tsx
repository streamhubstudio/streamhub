/**
 * Sistema / Mantenimiento tab — per-app SQLite (app.db) maintenance.
 *
 *  - GET  /apps/:app/db/health   → app.db size + per-table row counts.
 *  - POST /apps/:app/db/optimize → VACUUM/ANALYZE, shows before/after size.
 *  - POST /apps/:app/db/purge    → destructive; strong confirm modal (pick scope
 *                                  + type the confirmation phrase).
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '@/api'
import { Dialog } from '@/ui'
import type { DbOptimizeResult, DbPurgeScope } from '@/api'
import {
  Badge,
  Button,
  Card,
  Empty,
  ErrorBanner,
  Field,
  Loading,
  SectionTitle,
  Select,
  TextInput,
  errMessage,
} from './ui'

function fmtBytes(n?: number): string {
  if (n == null || n < 0) return '—'
  if (n === 0) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${u[i]}`
}

function fmtInt(n?: number): string {
  if (n == null) return '—'
  return n.toLocaleString()
}

/** before/after can arrive as beforeBytes/afterBytes; be defensive. */
function reclaimed(r: DbOptimizeResult): number | undefined {
  if (typeof r.reclaimedBytes === 'number') return r.reclaimedBytes
  const b = r.before?.sizeBytes
  const a = r.after?.sizeBytes
  if (typeof b === 'number' && typeof a === 'number') return b - a
  return undefined
}

const SCOPE_KEYS: DbPurgeScope[] = ['vods', 'logs', 'all']

export function MaintenanceTab({ app }: { app: string }) {
  return (
    <div className="space-y-5">
      <DbHealthCard app={app} />
    </div>
  )
}

function DbHealthCard({ app }: { app: string }) {
  const { t } = useTranslation(['maintenanceTab', 'common', 'appDetail'])
  const qc = useQueryClient()
  const [purgeOpen, setPurgeOpen] = useState(false)

  const health = useQuery({
    queryKey: ['app-db-health', app],
    queryFn: ({ signal }) => api.db.health(app, signal),
  })

  const optimize = useMutation({
    mutationFn: () => api.db.optimize(app),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['app-db-health', app] }),
  })

  const tables = health.data?.tables ?? []
  const optResult = optimize.data

  return (
    <>
      <Card className="p-0">
        <div className="p-5">
          <SectionTitle
            title={t('health.title')}
            right={
              <Button variant="ghost" onClick={() => health.refetch()}>
                {health.isFetching ? t('appDetail:state.updating') : t('common:actions.refresh')}
              </Button>
            }
          />

          {/* size summary */}
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <div className="rounded-lg border border-navy-600 bg-navy-700/40 px-4 py-3">
              <div className="text-[11px] uppercase tracking-wide text-slate-500">
                {t('health.dbSize')}
              </div>
              <div className="mt-0.5 text-lg font-semibold text-slate-100">
                {health.isLoading ? '…' : fmtBytes(health.data?.sizeBytes)}
              </div>
              {health.data?.walSizeBytes != null && health.data.walSizeBytes > 0 && (
                <div className="mt-0.5 text-[11px] text-slate-500">
                  {t('health.wal')} {fmtBytes(health.data.walSizeBytes)}
                </div>
              )}
            </div>
            {health.data?.path && (
              <div className="min-w-0">
                <div className="text-[11px] uppercase tracking-wide text-slate-500">
                  {t('health.path')}
                </div>
                <div className="mt-0.5 truncate font-mono text-xs text-slate-400">
                  {health.data.path}
                </div>
              </div>
            )}
          </div>

          {/* actions */}
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <Button
              variant="accent"
              disabled={optimize.isPending}
              onClick={() => optimize.mutate()}
            >
              {optimize.isPending ? t('health.optimizing') : t('health.optimize')}
            </Button>
            <Button variant="danger" onClick={() => setPurgeOpen(true)}>
              {t('health.purgeData')}
            </Button>

            {optResult && !optimize.isPending && (
              <span className="text-xs text-success">
                {t('health.optimized', {
                  before: fmtBytes(optResult.before?.sizeBytes),
                  after: fmtBytes(optResult.after?.sizeBytes),
                })}
                {(() => {
                  const r = reclaimed(optResult)
                  return r != null ? t('health.reclaimed', { size: fmtBytes(r) }) : ''
                })()}
              </span>
            )}
          </div>

          {optimize.isError && (
            <div className="mb-3">
              <ErrorBanner
                message={errMessage(optimize.error, t('health.optimizeError'))}
              />
            </div>
          )}
        </div>

        {/* per-table rows */}
        {health.isLoading ? (
          <Loading label={t('health.loading')} />
        ) : health.isError ? (
          <div className="p-5">
            <ErrorBanner
              message={errMessage(health.error, t('health.loadError'))}
            />
          </div>
        ) : tables.length === 0 ? (
          <Empty label={t('health.empty')} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-y border-navy-600 text-[11px] uppercase tracking-wide text-slate-500">
                <tr>
                  <Th>{t('health.table.name')}</Th>
                  <Th className="text-right">{t('health.table.rows')}</Th>
                  <Th className="text-right">{t('health.table.size')}</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-navy-600/40">
                {tables.map((t) => (
                  <tr key={t.name} className="hover:bg-navy-700/30">
                    <Td className="font-mono text-xs text-slate-300">{t.name}</Td>
                    <Td className="text-right text-slate-300">{fmtInt(t.rows)}</Td>
                    <Td className="text-right text-slate-400">{fmtBytes(t.bytes)}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {purgeOpen && (
        <PurgeModal
          app={app}
          onClose={() => setPurgeOpen(false)}
          onPurged={() => {
            setPurgeOpen(false)
            qc.invalidateQueries({ queryKey: ['app-db-health', app] })
            qc.invalidateQueries({ queryKey: ['app-vods', app] })
          }}
        />
      )}
    </>
  )
}

function PurgeModal({
  app,
  onClose,
  onPurged,
}: {
  app: string
  onClose: () => void
  onPurged: () => void
}) {
  const { t } = useTranslation(['maintenanceTab', 'common'])
  const [scope, setScope] = useState<DbPurgeScope>('vods')
  const [typed, setTyped] = useState('')

  const purge = useMutation({
    mutationFn: () => api.db.purge(app, { scope, confirm: true }),
    onSuccess: onPurged,
  })

  const confirmPhrase = t('confirmPhrase')
  const confirmed = typed.trim().toUpperCase() === confirmPhrase.toUpperCase()

  return (
    <Dialog isOpen width={460} closable={false} onClose={onClose} onRequestClose={onClose}>
      <div>
        <div className="mb-3 flex items-center justify-between gap-3">
          <h5 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            {t('purge.title')}
          </h5>
          <Badge tone="red">{t('purge.destructive')}</Badge>
        </div>

        <p className="mb-4 text-xs font-medium text-amber-600 dark:text-amber-300">
          {t('purge.warning')}
        </p>

        <div className="space-y-4">
          <Field label={t('purge.scopeLabel')} hint={t(`scope.${scope}.desc`)}>
            <Select
              value={scope}
              disabled={purge.isPending}
              onChange={(e) => setScope(e.target.value as DbPurgeScope)}
            >
              {SCOPE_KEYS.map((s) => (
                <option key={s} value={s}>
                  {t(`scope.${s}.label`)}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label={t('purge.confirmLabel', { phrase: confirmPhrase })}
            hint={t('purge.confirmHint')}
          >
            <TextInput
              value={typed}
              autoFocus
              disabled={purge.isPending}
              placeholder={confirmPhrase}
              onChange={(e) => setTyped(e.target.value)}
            />
          </Field>

          {purge.isError && (
            <ErrorBanner message={errMessage(purge.error, t('purge.error'))} />
          )}

          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" disabled={purge.isPending} onClick={onClose}>
              {t('common:actions.cancel')}
            </Button>
            <Button
              variant="danger"
              disabled={!confirmed || purge.isPending}
              onClick={() => purge.mutate()}
            >
              {purge.isPending ? t('purge.purging') : t('purge.purgeScope', { scope: t(`scope.${scope}.label`) })}
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  )
}

function Th({ children, className = '' }: { children?: React.ReactNode; className?: string }) {
  return <th className={`px-4 py-2 font-medium ${className}`}>{children}</th>
}
function Td({ children, className = '' }: { children?: React.ReactNode; className?: string }) {
  return <td className={`px-4 py-3 ${className}`}>{children}</td>
}
