/**
 * Downloadable, self-contained example bundles.
 *
 * Lists the example catalogue (GET /apps/:app/examples) and offers a per-example
 * zip download (GET /apps/:app/examples/:id.zip) plus a "download all". Each zip
 * is `index.html` + `config.js` + `README.md`, pre-configured for THIS app —
 * the user drops it on any static host and edits config.js to retarget.
 */
import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, saveBlob } from '@/api'
import type { ExampleInfo } from '@/api'
import { Button, Card, Empty, ErrorBanner, Loading, SectionTitle, errMessage } from './ui'

function authLabel(t: (k: string) => string, model: string): string {
  if (model === 'ephemeral') return t('downloads.auth.ephemeral')
  if (model === 'publisher') return t('downloads.auth.publisher')
  return t('downloads.auth.public')
}

export function ExampleDownloads({ app }: { app: string }) {
  const { t } = useTranslation('samplesTab')
  const list = useQuery({
    queryKey: ['app-examples', app],
    queryFn: ({ signal }) => api.apps.listExamples(app, signal),
  })

  const [busy, setBusy] = useState<string>('')
  const [error, setError] = useState<string>('')

  async function download(id: string, filename: string): Promise<void> {
    setBusy(id)
    setError('')
    try {
      const blob =
        id === '__all__'
          ? await api.apps.downloadAllExamplesZip(app)
          : await api.apps.downloadExampleZip(app, id)
      saveBlob(blob, filename)
    } catch (e) {
      setError(errMessage(e, t('downloads.downloadError')))
    } finally {
      setBusy('')
    }
  }

  const downloadAll = useMutation({
    mutationFn: () => download('__all__', 'streamhub-examples.zip'),
  })

  return (
    <Card>
      <SectionTitle
        title={t('downloads.title')}
        subtitle={t('downloads.subtitle')}
        right={
          <Button
            variant="ghost"
            disabled={busy !== '' || (list.data ?? []).length === 0}
            onClick={() => downloadAll.mutate()}
          >
            {busy === '__all__' ? t('downloads.downloading') : t('downloads.downloadAll')}
          </Button>
        }
      />

      {error && (
        <div className="mb-3">
          <ErrorBanner message={error} />
        </div>
      )}

      {list.isLoading ? (
        <Loading label={t('downloads.loading')} />
      ) : list.isError ? (
        <ErrorBanner message={errMessage(list.error, t('downloads.loadError'))} />
      ) : (list.data ?? []).length === 0 ? (
        <Empty label={t('downloads.empty')} />
      ) : (
        <ul className="divide-y divide-navy-700">
          {(list.data ?? []).map((ex: ExampleInfo) => (
            <li key={ex.id} className="flex items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-slate-100">{ex.title}</span>
                  <span className="rounded bg-navy-700 px-1.5 py-0.5 font-mono text-[10px] text-slate-400">
                    {ex.id}
                  </span>
                  <span className="rounded bg-blue2/15 px-1.5 py-0.5 text-[10px] text-blue2">
                    {authLabel(t, ex.authModel)}
                  </span>
                </div>
                <p className="mt-0.5 truncate text-xs text-slate-400">{ex.description}</p>
                <p className="mt-0.5 truncate text-[11px] text-slate-500">
                  {t('downloads.configHint', { keys: ex.requiredConfig.join(', ') })}
                </p>
              </div>
              <Button
                variant="ghost"
                disabled={busy !== ''}
                onClick={() => download(ex.id, `${ex.id}.zip`)}
              >
                {busy === ex.id ? t('downloads.downloading') : t('downloads.download')}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
