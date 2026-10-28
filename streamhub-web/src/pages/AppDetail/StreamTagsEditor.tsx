/**
 * Per-stream TAGS editor (StreamsTab "Tags" action).
 *
 * Applies/removes the app's tags on an ALREADY-created stream. Reads the app's
 * tags (GET /apps/:app/tags) and the stream's currently applied slugs
 * (GET /apps/:app/streams/:id/tags), lets the operator toggle each on/off, and
 * persists the new slug list on Save (PATCH /apps/:app/streams/:id/tags).
 *
 * A stream can only reference EXISTING tags, so this also offers a quick
 * "create tag" affordance (POST /apps/:app/tags) that adds the new tag to the
 * selection — otherwise an app with no tags yet would have nothing to apply.
 *
 * Mirrors {@link StreamPluginsEditor}: a self-contained leaf that fetches/saves
 * only its own state and invalidates the streams cache on success.
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/api'
import type { Stream, Tag } from '@/api'
import { Badge, Button, ErrorBanner, Loading, TextInput, errMessage } from './ui'

/** kebab-case slug, mirrors the core TAG_SLUG_RE. */
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function StreamTagsEditor({
  app,
  stream,
  onClose,
}: {
  app: string
  stream: Stream
  onClose: () => void
}) {
  const { t } = useTranslation(['streamsTab', 'common'])
  const qc = useQueryClient()

  const tagsQuery = useQuery({
    queryKey: ['app-tags', app],
    queryFn: ({ signal }) => api.tags.list(app, undefined, signal),
    retry: false,
  })

  const appliedQuery = useQuery({
    queryKey: ['stream-tags', app, stream.streamId],
    queryFn: ({ signal }) => api.streams.getTags(app, stream.streamId, signal),
    retry: false,
  })

  // Local working copy of the applied slugs, seeded once from the server.
  const [selected, setSelected] = useState<string[] | null>(null)
  useEffect(() => {
    if (appliedQuery.data && selected === null) setSelected(appliedQuery.data.tags)
  }, [appliedQuery.data, selected])
  const current = selected ?? appliedQuery.data?.tags ?? []

  // Quick create-tag form.
  const [newSlug, setNewSlug] = useState('')
  const [newLabel, setNewLabel] = useState('')

  const create = useMutation({
    mutationFn: (payload: { slug: string; label: string }) =>
      api.tags.create(app, payload),
    onSuccess: (tag: Tag) => {
      qc.invalidateQueries({ queryKey: ['app-tags', app] })
      setSelected((prev) => {
        const base = prev ?? appliedQuery.data?.tags ?? []
        return base.includes(tag.slug) ? base : [...base, tag.slug]
      })
      setNewSlug('')
      setNewLabel('')
    },
  })

  const save = useMutation({
    mutationFn: (slugs: string[]) => api.streams.setTags(app, stream.streamId, slugs),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['stream-tags', app, stream.streamId] })
      qc.invalidateQueries({ queryKey: ['app-streams', app] })
      onClose()
    },
  })

  function toggle(slug: string) {
    setSelected((prev) => {
      const base = prev ?? appliedQuery.data?.tags ?? []
      return base.includes(slug) ? base.filter((s) => s !== slug) : [...base, slug]
    })
  }

  const tags = tagsQuery.data ?? []
  const loading = tagsQuery.isLoading || appliedQuery.isLoading
  const loadError = tagsQuery.isError || appliedQuery.isError
  const canCreate =
    SLUG_RE.test(newSlug.trim()) && newLabel.trim().length > 0 && !create.isPending

  return (
    <div className="space-y-4">
      <div>
        <h5 className="text-base font-semibold text-gray-100">
          {t('tags.title')}
        </h5>
        <p className="mt-1 text-xs text-slate-500">{t('tags.help')}</p>
        <p className="mt-1 font-mono text-[11px] text-slate-500">{stream.streamId}</p>
      </div>

      {loading ? (
        <Loading label={t('tags.loading')} />
      ) : loadError ? (
        <ErrorBanner
          message={errMessage(tagsQuery.error ?? appliedQuery.error, t('tags.loadError'))}
        />
      ) : tags.length === 0 ? (
        <p className="py-4 text-center text-sm text-slate-500">{t('tags.empty')}</p>
      ) : (
        <ul className="max-h-60 space-y-2 overflow-auto">
          {tags.map((tag) => {
            const on = current.includes(tag.slug)
            return (
              <li
                key={tag.slug}
                className="flex items-center justify-between gap-4 rounded-lg border border-navy-600 px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-slate-100">
                      {tag.label}
                    </span>
                    {tag.kind && tag.kind !== 'custom' && (
                      <Badge tone="slate">{tag.kind}</Badge>
                    )}
                  </div>
                  <div className="truncate font-mono text-[11px] text-slate-500">
                    {tag.slug}
                  </div>
                </div>
                <input
                  type="checkbox"
                  aria-label={tag.label}
                  checked={on}
                  onChange={() => toggle(tag.slug)}
                  className="h-5 w-5 shrink-0 accent-primary-500"
                />
              </li>
            )
          })}
        </ul>
      )}

      {/* Quick create-tag — a stream can only reference existing tags. */}
      <div className="rounded-lg border border-dashed border-navy-600 p-3">
        <p className="mb-2 text-xs font-semibold text-slate-400">{t('tags.createTitle')}</p>
        <div className="flex flex-wrap items-end gap-2">
          <label className="min-w-0 flex-1">
            <span className="mb-1 block text-[11px] text-slate-500">{t('tags.slug')}</span>
            <TextInput
              value={newSlug}
              placeholder="store-downtown"
              onChange={(e) => setNewSlug(e.currentTarget.value)}
              className="font-mono"
            />
          </label>
          <label className="min-w-0 flex-1">
            <span className="mb-1 block text-[11px] text-slate-500">{t('tags.label')}</span>
            <TextInput
              value={newLabel}
              placeholder="Downtown Store"
              onChange={(e) => setNewLabel(e.currentTarget.value)}
            />
          </label>
          <Button
            variant="ghost"
            disabled={!canCreate}
            onClick={() => create.mutate({ slug: newSlug.trim(), label: newLabel.trim() })}
          >
            {create.isPending ? t('tags.creating') : t('tags.create')}
          </Button>
        </div>
        {create.isError && (
          <div className="mt-2">
            <ErrorBanner message={errMessage(create.error, t('tags.createError'))} />
          </div>
        )}
      </div>

      {save.isError && (
        <ErrorBanner message={errMessage(save.error, t('tags.saveError'))} />
      )}

      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          {t('common:actions.close')}
        </Button>
        <Button
          variant="accent"
          disabled={loading || loadError || save.isPending}
          onClick={() => save.mutate(current)}
        >
          {save.isPending ? t('tags.saving') : t('tags.save')}
        </Button>
      </div>
    </div>
  )
}
