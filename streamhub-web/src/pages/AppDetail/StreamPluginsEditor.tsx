/**
 * Per-stream plugin opt-out editor (StreamsTab "Plugins" action).
 *
 * By default a plugin enabled on the app applies to EVERY live stream. This
 * editor lists the app's stream-affecting (player-overlay) plugins with a
 * per-stream toggle: ON = the stream is affected (default); OFF = this ONE
 * stream is opted OUT of that plugin. It reads the stream's current opt-out
 * list (GET /apps/:app/streams/:id/plugins) and persists the new list on Save
 * (PATCH …), then invalidates the plugin caches so any open player re-resolves
 * its overlays.
 *
 * `plugins` (the app's enabled overlay plugins) is passed in by the host so the
 * editor stays a pure, easily-testable leaf; it fetches/saves ONLY the opt-out
 * list itself.
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/api'
import type { Stream } from '@/api'
import { Button, ErrorBanner, Loading } from './ui'
import { errMessage } from './ui'

/** One selectable plugin (the app's enabled overlay plugins). */
export interface StreamEditablePlugin {
  id: string
  name: string
}

export function StreamPluginsEditor({
  app,
  stream,
  plugins,
  onClose,
}: {
  app: string
  stream: Stream
  plugins: StreamEditablePlugin[]
  onClose: () => void
}) {
  const { t } = useTranslation(['streamsTab', 'common'])
  const qc = useQueryClient()

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['stream-plugins', app, stream.streamId],
    queryFn: ({ signal }) => api.streams.getPlugins(app, stream.streamId, signal),
    retry: false,
  })

  // Local working copy of the opted-OUT id list, seeded once from the server.
  const [disabled, setDisabled] = useState<string[] | null>(null)
  useEffect(() => {
    if (data && disabled === null) setDisabled(data.disabled)
  }, [data, disabled])
  const current = disabled ?? data?.disabled ?? []

  const save = useMutation({
    mutationFn: (ids: string[]) => api.streams.setPlugins(app, stream.streamId, ids),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['stream-plugins', app, stream.streamId] })
      // Re-resolve any open player's overlays (scoped catalog keys start here).
      qc.invalidateQueries({ queryKey: ['plugins', app] })
      onClose()
    },
  })

  /** Flip whether a plugin AFFECTS this stream (affected = not in disabled). */
  function setAffected(id: string, affected: boolean) {
    setDisabled((prev) => {
      const base = prev ?? data?.disabled ?? []
      if (affected) return base.filter((x) => x !== id)
      return base.includes(id) ? base : [...base, id]
    })
  }

  return (
    <div className="space-y-4">
      <div>
        <h5 className="text-base font-semibold text-gray-100">
          {t('plugins.title')}
        </h5>
        <p className="mt-1 text-xs text-slate-500">{t('plugins.help')}</p>
        <p className="mt-1 font-mono text-[11px] text-slate-500">{stream.streamId}</p>
      </div>

      {isLoading ? (
        <Loading label={t('plugins.loading')} />
      ) : isError ? (
        <ErrorBanner message={errMessage(error, t('plugins.loadError'))} />
      ) : plugins.length === 0 ? (
        <p className="py-6 text-center text-sm text-slate-500">{t('plugins.empty')}</p>
      ) : (
        <ul className="space-y-2">
          {plugins.map((p) => {
            const affected = !current.includes(p.id)
            return (
              <li
                key={p.id}
                className="flex items-center justify-between gap-4 rounded-lg border border-navy-600 px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-slate-100">
                    {p.name}
                  </div>
                  <div className="text-[11px] text-slate-500">
                    {affected ? t('plugins.affected') : t('plugins.optedOut')}
                  </div>
                </div>
                <input
                  type="checkbox"
                  aria-label={p.name}
                  checked={affected}
                  onChange={(e) => setAffected(p.id, e.currentTarget.checked)}
                  className="h-5 w-5 shrink-0 accent-primary-500"
                />
              </li>
            )
          })}
        </ul>
      )}

      {save.isError && (
        <ErrorBanner message={errMessage(save.error, t('plugins.saveError'))} />
      )}

      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          {t('common:actions.close')}
        </Button>
        <Button
          variant="accent"
          disabled={isLoading || isError || save.isPending}
          onClick={() => save.mutate(current)}
        >
          {save.isPending ? t('plugins.saving') : t('plugins.save')}
        </Button>
      </div>
    </div>
  )
}
