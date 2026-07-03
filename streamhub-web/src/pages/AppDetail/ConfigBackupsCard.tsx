/**
 * Config backups (Wave 5 / Fold 2). Every write to config.yaml leaves a
 * timestamped backup (config.yaml.bak.<ts>). Here you can:
 *   - list them (GET /apps/:app/config/backups),
 *   - preview a backup's YAML (GET .../backups/:file),
 *   - revert to it (POST .../backups/:file/restore) behind a confirm.
 */
import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '@/api'
import { CodeEditor } from './CodeEditor'
import {
  Button,
  Card,
  Empty,
  ErrorBanner,
  Loading,
  Select,
  SectionTitle,
  errMessage,
} from './ui'

function backupLabel(file: string, createdAt?: string): string {
  if (createdAt) {
    const d = new Date(createdAt)
    if (!Number.isNaN(d.getTime())) return `${file} · ${d.toLocaleString()}`
  }
  return file
}

export function ConfigBackupsCard({ app }: { app: string }) {
  const { t } = useTranslation(['configTab', 'common', 'appDetail'])
  const qc = useQueryClient()
  const list = useQuery({
    queryKey: ['app-config-backups', app],
    queryFn: ({ signal }) => api.apps.listConfigBackups(app, signal),
  })

  const [selected, setSelected] = useState('')

  useEffect(() => {
    const files = list.data ?? []
    if (files.length === 0) {
      setSelected('')
      return
    }
    if (!files.some((b) => b.ts === selected)) setSelected(files[0].ts)
  }, [list.data, selected])

  const preview = useQuery({
    queryKey: ['app-config-backup', app, selected],
    queryFn: ({ signal }) => api.apps.getConfigBackup(app, selected, signal),
    enabled: Boolean(selected),
  })

  const restore = useMutation({
    mutationFn: () => api.apps.restoreConfigBackup(app, selected),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['app-config', app] })
      qc.invalidateQueries({ queryKey: ['app-config-raw', app] })
      qc.invalidateQueries({ queryKey: ['app-s3', app] })
      qc.invalidateQueries({ queryKey: ['app-config-backups', app] })
    },
  })

  function onRestore() {
    const ok = window.confirm(t('backups.confirmRestore', { app, ts: selected }))
    if (ok) restore.mutate()
  }

  return (
    <Card>
      <SectionTitle
        title={t('backups.title')}
        subtitle={t('backups.subtitle')}
        right={
          <Button
            variant="ghost"
            disabled={list.isFetching}
            onClick={() => list.refetch()}
          >
            {list.isFetching ? t('appDetail:state.updating') : t('common:actions.refresh')}
          </Button>
        }
      />

      {list.isLoading ? (
        <Loading label={t('backups.loading')} />
      ) : list.isError ? (
        <ErrorBanner message={errMessage(list.error, t('backups.loadError'))} />
      ) : (list.data ?? []).length === 0 ? (
        <Empty label={t('backups.empty')} />
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[16rem] flex-1">
              <span className="mb-1 block text-xs font-medium text-slate-300">{t('backups.backupLabel')}</span>
              <Select value={selected} onChange={(e) => setSelected(e.target.value)}>
                {(list.data ?? []).map((b) => (
                  <option key={b.ts} value={b.ts}>
                    {backupLabel(b.file, b.createdAt)}
                  </option>
                ))}
              </Select>
            </div>
            <Button
              variant="danger"
              disabled={!selected || restore.isPending}
              onClick={onRestore}
            >
              {restore.isPending ? t('backups.reverting') : t('backups.revert')}
            </Button>
          </div>

          {restore.isError && (
            <ErrorBanner message={errMessage(restore.error, t('backups.restoreError'))} />
          )}
          {restore.isSuccess && (
            <p className="text-xs text-success">
              {t('backups.restoreSuccess', { ts: selected })}
            </p>
          )}

          {selected && (
            <div>
              <span className="mb-1 block text-xs font-medium text-slate-300">
                {t('backups.contentLabel')}
              </span>
              {preview.isLoading ? (
                <Loading label={t('appDetail:state.loadingDefault')} />
              ) : preview.isError ? (
                <ErrorBanner
                  message={errMessage(preview.error, t('backups.previewError'))}
                />
              ) : (
                <CodeEditor
                  value={preview.data?.yaml ?? ''}
                  ariaLabel={`backup ${selected}`}
                  readOnly
                  onChange={() => {}}
                />
              )}
            </div>
          )}
        </div>
      )}
    </Card>
  )
}
