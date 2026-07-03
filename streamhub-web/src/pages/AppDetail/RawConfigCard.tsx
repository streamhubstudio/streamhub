/**
 * Raw config.yaml editor (Wave 4, spec §1).
 *
 *  - GET /apps/:app/config/raw → loads the verbatim YAML into a monospace editor.
 *  - PUT /apps/:app/config/raw → validates + writes + hot-reloads. Parse errors
 *    come back as 400 and are shown inline (nothing is written server-side).
 *  - POST /apps/:app/reload → manual hot-reload (no process restart).
 *  - POST /admin/restart → restarts streamhub-core. De-emphasised (bottom
 *    "danger zone") and gated behind a strong acknowledgement modal, because it
 *    cuts the live streams of ALL apps, not just this one.
 */
import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type ConfigDryRunResult } from '@/api'
import { CodeEditor } from './CodeEditor'
import { RestartServerDialog } from './RestartServerDialog'
import { Badge, Button, Card, ErrorBanner, Loading, SectionTitle, errMessage } from './ui'

export function RawConfigCard({ app }: { app: string }) {
  const { t } = useTranslation(['configTab', 'common'])
  const qc = useQueryClient()
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['app-config-raw', app],
    queryFn: ({ signal }) => api.apps.getConfigRaw(app, signal),
  })

  const [yaml, setYaml] = useState('')
  const [dirty, setDirty] = useState(false)
  const [restartOpen, setRestartOpen] = useState(false)

  useEffect(() => {
    if (data) {
      setYaml(data.yaml ?? '')
      setDirty(false)
    }
  }, [data])

  const save = useMutation({
    mutationFn: () => api.apps.putConfigRaw(app, yaml),
    onSuccess: () => {
      setDirty(false)
      // Other tabs read the parsed config — refresh them too.
      qc.invalidateQueries({ queryKey: ['app-config', app] })
      qc.invalidateQueries({ queryKey: ['app-config-raw', app] })
      qc.invalidateQueries({ queryKey: ['app-s3', app] })
    },
  })

  const reload = useMutation({ mutationFn: () => api.apps.reload(app) })
  const restart = useMutation({
    mutationFn: () => api.admin.restart(),
    onSuccess: () => setRestartOpen(false),
  })

  // Fold 2: validate the candidate YAML + show the diff WITHOUT writing.
  const dryRun = useMutation({ mutationFn: () => api.apps.dryRunConfigRaw(app, yaml) })

  if (isLoading) return <Loading label={t('raw.loading')} />
  if (isError)
    return <ErrorBanner message={errMessage(error, t('raw.loadError'))} />

  const warnings = save.data?.warnings ?? []

  return (
    <Card>
      <SectionTitle
        title={t('raw.title')}
        subtitle={t('raw.subtitle')}
        right={
          <div className="flex shrink-0 items-center gap-2">
            <Badge tone="cyan">{t('raw.sourceOfTruthBadge')}</Badge>
            <Button
              variant="ghost"
              disabled={reload.isPending}
              onClick={() => reload.mutate()}
              title={t('raw.reloadTooltip')}
            >
              {reload.isPending ? t('raw.reloading') : t('raw.reloadApp')}
            </Button>
          </div>
        }
      />

      <p className="mb-3 rounded-lg border border-sky2/20 bg-sky2/5 px-3 py-2 text-[11px] text-slate-400">
        {t('raw.sourceOfTruthNote')}
      </p>

      <CodeEditor
        value={yaml}
        ariaLabel="config.yaml"
        onChange={(v) => {
          setYaml(v)
          setDirty(true)
          if (save.isError || save.isSuccess) save.reset()
          // A stale diff would be misleading once the text changes.
          if (dryRun.data || dryRun.isError) dryRun.reset()
        }}
      />

      {/* Fold 2 — dry-run result: diff + warnings/errors, nothing written. */}
      {dryRun.isError && (
        <div className="mt-3">
          <ErrorBanner message={errMessage(dryRun.error, t('raw.dryRunError'))} />
        </div>
      )}
      {dryRun.data && <DryRunResult result={dryRun.data} />}

      {save.isError && (
        <div className="mt-3">
          <ErrorBanner
            message={errMessage(save.error, t('raw.saveError'))}
          />
        </div>
      )}

      {reload.isError && (
        <div className="mt-3">
          <ErrorBanner message={errMessage(reload.error, t('raw.reloadError'))} />
        </div>
      )}

      {save.isSuccess && !dirty && (
        <div className="mt-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-xs text-success">
          {save.data?.reloaded ? t('raw.savedReloaded') : t('raw.savedWritten')}
          {warnings.length > 0 && (
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-warn">
              {warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {reload.isSuccess && (
        <p className="mt-3 text-xs text-success">{t('raw.reloadSuccess')}</p>
      )}

      <div className="mt-4 flex items-center gap-3">
        <Button
          variant="accent"
          disabled={save.isPending || !dirty}
          onClick={() => save.mutate()}
          title={t('raw.saveTooltip')}
        >
          {save.isPending ? t('common:state.saving') : t('raw.saveYaml')}
        </Button>
        <Button
          variant="ghost"
          disabled={dryRun.isPending}
          onClick={() => dryRun.mutate()}
          title={t('raw.dryRunTooltip')}
        >
          {dryRun.isPending ? t('raw.validating') : t('raw.validate')}
        </Button>
        {dirty && <span className="text-xs text-warn">{t('raw.unsavedChanges')}</span>}
      </div>

      {/* Danger zone — de-emphasised: the process-level restart lives here,
          muted and out of the way, gated behind a strong acknowledgement. */}
      <div className="mt-6 border-t border-navy-600/60 pt-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
              {t('raw.dangerZoneTitle')}
            </div>
            <p className="mt-0.5 text-[11px] text-slate-500">{t('raw.restartServerHint')}</p>
          </div>
          <button
            type="button"
            onClick={() => setRestartOpen(true)}
            disabled={restart.isPending}
            title={t('raw.restartTooltip')}
            className="self-start rounded-lg px-2 py-1.5 text-[11px] text-slate-500 underline decoration-dotted underline-offset-4 transition hover:text-danger disabled:opacity-50 sm:self-auto"
          >
            {t('raw.restartServer')}
          </button>
        </div>
        {restart.isSuccess && (
          <p className="mt-2 text-xs text-success">{t('raw.restartSuccess')}</p>
        )}
      </div>

      {restartOpen && (
        <RestartServerDialog
          pending={restart.isPending}
          error={restart.isError ? errMessage(restart.error, t('raw.restartError')) : null}
          onConfirm={() => restart.mutate()}
          onClose={() => {
            if (restart.isPending) return
            setRestartOpen(false)
            if (restart.isError) restart.reset()
          }}
        />
      )}
    </Card>
  )
}

/** Renders a dry-run outcome: a colorized unified diff + warnings/errors. */
function DryRunResult({ result }: { result: ConfigDryRunResult }) {
  const { t } = useTranslation('configTab')
  const diff = result.diff?.trim() ?? ''
  return (
    <div className="mt-3 space-y-3">
      <div
        className={[
          'rounded-lg border px-4 py-2 text-xs',
          result.valid
            ? 'border-emerald-500/30 bg-emerald-500/10 text-success'
            : 'border-red-500/30 bg-red-500/10 text-danger',
        ].join(' ')}
      >
        {result.valid
          ? diff
            ? t('raw.dryRun.validWithDiff')
            : t('raw.dryRun.validNoDiff')
          : t('raw.dryRun.invalid')}
      </div>

      {(result.errors?.length ?? 0) > 0 && (
        <ul className="list-disc space-y-0.5 rounded-lg border border-red-500/30 bg-red-500/5 px-5 py-3 text-xs text-danger">
          {result.errors!.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}
      {(result.warnings?.length ?? 0) > 0 && (
        <ul className="list-disc space-y-0.5 rounded-lg border border-amber-500/30 bg-amber-500/5 px-5 py-3 text-xs text-warn">
          {result.warnings!.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}

      {diff && (
        <pre className="max-h-80 overflow-auto rounded-lg border border-navy-600 bg-navy-900/60 p-3 font-mono text-[11px] leading-relaxed">
          {diff.split('\n').map((line, i) => {
            const tone = line.startsWith('+')
              ? 'text-success'
              : line.startsWith('-')
                ? 'text-danger'
                : line.startsWith('@@')
                  ? 'text-sky2'
                  : 'text-slate-400'
            return (
              <div key={i} className={tone}>
                {line || ' '}
              </div>
            )
          })}
        </pre>
      )}
    </div>
  )
}
