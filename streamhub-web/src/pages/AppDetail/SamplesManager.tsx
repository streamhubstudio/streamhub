/**
 * Per-app HTML samples manager (Wave 4, spec §3).
 *
 * Lists the generated samples (GET /apps/:app/samples), and for the selected
 * file: loads it (GET :file), edits + saves it (PUT :file), previews it in an
 * iframe (/samples/<app>/<file>) and exposes copyable URL/embed. "Regenerar"
 * (POST regenerate) rebuilds them from the templates.
 *
 * Editing a sample only affects THIS app — each app has its own samples dir.
 */
import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Trans, useTranslation } from 'react-i18next'
import { api } from '@/api'
import type { Sample } from '@/api'
import { CodeEditor } from './CodeEditor'
import {
  Button,
  Card,
  CopyField,
  Empty,
  ErrorBanner,
  Loading,
  SectionTitle,
  errMessage,
} from './ui'

/** Public URL where the rendered sample HTML is served. */
function sampleUrl(app: string, file: string): string {
  const base = typeof window !== 'undefined' ? window.location.origin : ''
  return `${base}/samples/${encodeURIComponent(app)}/${encodeURIComponent(file)}`
}

export function SamplesManager({ app }: { app: string }) {
  const { t } = useTranslation(['samplesTab', 'common'])
  const qc = useQueryClient()
  const list = useQuery({
    queryKey: ['app-samples', app],
    queryFn: ({ signal }) => api.apps.listSamples(app, signal),
  })

  const [selected, setSelected] = useState<string>('')

  // Pick the first sample once the list loads (and recover if it disappears).
  useEffect(() => {
    const files = list.data ?? []
    if (files.length === 0) {
      setSelected('')
      return
    }
    if (!files.some((s) => s.file === selected)) {
      setSelected(files[0].file)
    }
  }, [list.data, selected])

  const regenerate = useMutation({
    mutationFn: () => api.apps.regenerateSamples(app),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['app-samples', app] })
      if (selected) qc.invalidateQueries({ queryKey: ['app-sample', app, selected] })
    },
  })

  return (
    <Card>
      <SectionTitle
        title={t('manager.title')}
        subtitle={t('manager.subtitle')}
        right={
          <Button
            variant="ghost"
            disabled={regenerate.isPending}
            onClick={() => regenerate.mutate()}
            title={t('manager.regenerateTooltip')}
          >
            {regenerate.isPending ? t('manager.regenerating') : t('manager.regenerate')}
          </Button>
        }
      />

      {regenerate.isError && (
        <div className="mb-3">
          <ErrorBanner
            message={errMessage(regenerate.error, t('manager.regenerateError'))}
          />
        </div>
      )}
      {regenerate.isSuccess && (
        <p className="mb-3 text-xs text-success">{t('manager.regenerateSuccess')}</p>
      )}

      {list.isLoading ? (
        <Loading label={t('manager.loading')} />
      ) : list.isError ? (
        <ErrorBanner message={errMessage(list.error, t('manager.loadError'))} />
      ) : (list.data ?? []).length === 0 ? (
        <Empty label={t('manager.empty')} />
      ) : (
        <div className="space-y-4">
          {/* File chips */}
          <div className="flex flex-wrap gap-2">
            {(list.data ?? []).map((s) => (
              <SampleChip
                key={s.file}
                sample={s}
                active={s.file === selected}
                onClick={() => setSelected(s.file)}
              />
            ))}
          </div>

          {selected && <SampleEditor app={app} file={selected} />}
        </div>
      )}
    </Card>
  )
}

function SampleChip({
  sample,
  active,
  onClick,
}: {
  sample: Sample
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      title={sample.description || sample.title}
      className={[
        'rounded-lg px-3 py-1.5 font-mono text-xs transition',
        active
          ? 'bg-blue2/20 text-slate-100 ring-1 ring-blue2/40'
          : 'border border-navy-600 text-slate-300 hover:text-slate-100',
      ].join(' ')}
    >
      {sample.file}
    </button>
  )
}

function SampleEditor({ app, file }: { app: string; file: string }) {
  const { t } = useTranslation(['samplesTab', 'common'])
  const qc = useQueryClient()
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['app-sample', app, file],
    queryFn: ({ signal }) => api.apps.getSample(app, file, signal),
  })

  const [content, setContent] = useState('')
  const [dirty, setDirty] = useState(false)
  const [showPreview, setShowPreview] = useState(false)
  // Bump to force the iframe to reload after a save.
  const [previewNonce, setPreviewNonce] = useState(0)

  useEffect(() => {
    if (typeof data === 'string') {
      setContent(data)
      setDirty(false)
    }
  }, [data])

  const save = useMutation({
    mutationFn: () => api.apps.putSample(app, file, content),
    onSuccess: () => {
      setDirty(false)
      setPreviewNonce((n) => n + 1)
      qc.invalidateQueries({ queryKey: ['app-sample', app, file] })
    },
  })

  if (isLoading) return <Loading label={t('editor.loadingFile', { file })} />
  if (isError)
    return <ErrorBanner message={errMessage(error, t('editor.loadFileError', { file }))} />

  const url = sampleUrl(app, file)
  const embed = `<iframe src="${url}" width="640" height="360" allow="autoplay; camera; microphone; fullscreen" style="border:0"></iframe>`

  return (
    <div className="space-y-4 rounded-xl border border-navy-600 bg-navy-800/40 p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-xs text-slate-300">{file}</span>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            onClick={() => {
              setShowPreview((v) => !v)
              setPreviewNonce((n) => n + 1)
            }}
          >
            {showPreview ? t('editor.hidePreview') : t('editor.preview')}
          </Button>
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="rounded-lg border border-navy-600 px-3 py-2 text-xs text-slate-300 transition hover:text-slate-100"
          >
            {t('editor.open')}
          </a>
        </div>
      </div>

      <CodeEditor
        value={content}
        ariaLabel={file}
        onChange={(v) => {
          setContent(v)
          setDirty(true)
          if (save.isError || save.isSuccess) save.reset()
        }}
      />

      {save.isError && (
        <ErrorBanner message={errMessage(save.error, t('editor.saveError'))} />
      )}

      <div className="flex items-center gap-3">
        <Button
          variant="accent"
          disabled={save.isPending || !dirty}
          onClick={() => save.mutate()}
        >
          {save.isPending ? t('common:state.saving') : t('common:actions.save')}
        </Button>
        {dirty && <span className="text-xs text-warn">{t('editor.unsavedChanges')}</span>}
        {save.isSuccess && !dirty && (
          <span className="text-xs text-success">{t('editor.savedThisApp')}</span>
        )}
      </div>

      <div className="space-y-3">
        <CopyField label={t('editor.publicUrl')} value={url} mono={false} />
        <CopyField label={t('editor.embedIframe')} value={embed} />
      </div>

      {showPreview && (
        <div>
          <span className="mb-1 block text-xs font-medium text-slate-300">{t('editor.previewLabel')}</span>
          <div className="aspect-video w-full overflow-hidden rounded-lg border border-navy-600 bg-black">
            <iframe
              key={previewNonce}
              src={url}
              title={`preview-${file}`}
              // Fold 4: sandbox SIN `allow-same-origin`. Un sample editado es JS
              // arbitrario; al correr en un origen «opaco» no puede leer el token
              // ni el localStorage/cookies del panel. Mantenemos allow-scripts
              // (el sample necesita JS) + forms/popups/modals para la demo.
              sandbox="allow-scripts allow-forms allow-popups allow-modals allow-presentation"
              allow="autoplay; camera; microphone; fullscreen; picture-in-picture"
              referrerPolicy="no-referrer"
              className="h-full w-full"
            />
          </div>
          <p className="mt-1 text-[11px] text-slate-500">
            <Trans
              t={t}
              i18nKey="editor.previewHelp"
              components={[
                <span className="font-mono" key="0" />,
                <span className="font-mono" key="1" />,
                <em key="2" />,
              ]}
            />
          </p>
        </div>
      )}
    </div>
  )
}
