/**
 * Restream (reenvío multi-destino) dialog — per live stream.
 *
 * GET/POST/DELETE /apps/:app/streams/:id/restream: add forwarding destinations
 * (YouTube/Twitch/Facebook preset + stream key, or a custom rtmp(s):// URL),
 * see each destination's state (starting/active/failed badge) and stop each
 * one independently. URLs come back MASKED — the key never leaves the server.
 */
import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '@/api'
import type { RestreamPlatform, RestreamTarget, Stream } from '@/api'
import { Dialog } from '@/ui'
import {
  buildRestreamPreview,
  RESTREAM_PLATFORMS,
  RESTREAM_PRESETS,
  validateRestreamInput,
} from '@/lib/restream'
import {
  Badge,
  Button,
  ErrorBanner,
  Field,
  Select,
  SectionTitle,
  TextInput,
  errMessage,
} from './ui'

const STATUS_TONE: Record<string, 'amber' | 'green' | 'red' | 'slate'> = {
  starting: 'amber',
  active: 'green',
  failed: 'red',
  stopped: 'slate',
}

function platformLabel(p: string): string {
  return p in RESTREAM_PRESETS
    ? RESTREAM_PRESETS[p as Exclude<RestreamPlatform, 'custom'>].label
    : p
}

export function RestreamDialog({
  app,
  stream,
  onClose,
}: {
  app: string
  stream: Stream
  onClose: () => void
}) {
  const { t } = useTranslation(['restream', 'common'])
  const qc = useQueryClient()
  const streamId = stream.streamId

  const [platform, setPlatform] = useState<RestreamPlatform>('youtube')
  const [key, setKey] = useState('')
  const [url, setUrl] = useState('')
  const [name, setName] = useState('')
  const [touched, setTouched] = useState(false)

  const queryKey = ['app-restream', app, streamId]
  const { data, isLoading, isError, error } = useQuery({
    queryKey,
    queryFn: ({ signal }) => api.restream.list(app, streamId, signal),
    // Endpoints move starting → active/failed via webhooks; poll while open.
    refetchInterval: 5_000,
  })

  const add = useMutation({
    mutationFn: () =>
      api.restream.add(app, streamId, {
        platform,
        key: key.trim() || undefined,
        url: url.trim() || undefined,
        name: name.trim() || undefined,
      }),
    onSuccess: () => {
      setKey('')
      setUrl('')
      setName('')
      setTouched(false)
      qc.invalidateQueries({ queryKey })
    },
  })

  const remove = useMutation({
    mutationFn: (egressId: string) => api.restream.remove(app, streamId, egressId),
    onSuccess: () => qc.invalidateQueries({ queryKey }),
  })

  const formError = useMemo(
    () => validateRestreamInput(platform, key, url),
    [platform, key, url],
  )
  const preview = useMemo(
    () => buildRestreamPreview(platform, key, url),
    [platform, key, url],
  )
  const targets: RestreamTarget[] = data ?? []

  function submit() {
    setTouched(true)
    if (formError) return
    add.mutate()
  }

  return (
    <Dialog
      isOpen
      width={720}
      closable={false}
      onClose={onClose}
      onRequestClose={onClose}
    >
      <div className="max-h-[80vh] overflow-y-auto">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <h5 className="text-base font-semibold text-gray-900 dark:text-gray-100">
              {t('title')}
              {' · '}
              <span className="font-mono">{stream.room}</span>
            </h5>
          </div>
          <Button variant="ghost" onClick={onClose}>
            {t('common:actions.close')}
          </Button>
        </div>

        <p className="mb-4 text-xs text-gray-500 dark:text-gray-400">
          {t('subtitle')}
        </p>

        {/* --- add destination form ------------------------------------- */}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('form.platform')}>
            <Select
              value={platform}
              onChange={(e) => {
                setPlatform(e.target.value as RestreamPlatform)
                setTouched(false)
              }}
            >
              {RESTREAM_PLATFORMS.map((p) => (
                <option key={p} value={p}>
                  {p === 'custom' ? t('form.customPlatform') : platformLabel(p)}
                </option>
              ))}
            </Select>
          </Field>

          <Field label={t('form.name')} hint={t('form.nameHint')}>
            <TextInput
              value={name}
              maxLength={120}
              placeholder={t('form.namePlaceholder')}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>

          {platform === 'custom' ? (
            <div className="sm:col-span-2">
              <Field label={t('form.url')} hint={t('form.urlHint')}>
                <TextInput
                  value={url}
                  maxLength={2000}
                  placeholder="rtmp://ingest.example.com/live/stream-key"
                  className="font-mono text-xs"
                  onChange={(e) => setUrl(e.target.value)}
                  onBlur={() => setTouched(true)}
                />
              </Field>
            </div>
          ) : (
            <div className="sm:col-span-2">
              <Field label={t('form.key')} hint={t('form.keyHint')}>
                <TextInput
                  value={key}
                  maxLength={500}
                  type="password"
                  autoComplete="off"
                  placeholder={t('form.keyPlaceholder')}
                  className="font-mono text-xs"
                  onChange={(e) => setKey(e.target.value)}
                  onBlur={() => setTouched(true)}
                />
              </Field>
            </div>
          )}
        </div>

        {preview && (
          <p className="mt-2 break-all font-mono text-[11px] text-gray-500 dark:text-gray-400">
            → {preview}
          </p>
        )}
        {touched && formError && (
          <div className="mt-2">
            <ErrorBanner message={t(`formError.${formError}`)} />
          </div>
        )}
        {add.isError && (
          <div className="mt-2">
            <ErrorBanner message={errMessage(add.error, t('error.add'))} />
          </div>
        )}

        <div className="mt-3 flex justify-end">
          <Button
            variant="accent"
            disabled={add.isPending || Boolean(formError)}
            onClick={submit}
          >
            {add.isPending ? t('actions.adding') : t('actions.add')}
          </Button>
        </div>

        {/* --- destinations list ----------------------------------------- */}
        <div className="mt-5">
          <SectionTitle title={t('list.title')} />
          {remove.isError && (
            <div className="mb-2">
              <ErrorBanner message={errMessage(remove.error, t('error.stop'))} />
            </div>
          )}
          {isLoading ? (
            <p className="py-4 text-center text-sm text-gray-500">
              {t('list.loading')}
            </p>
          ) : isError ? (
            <ErrorBanner message={errMessage(error, t('error.load'))} />
          ) : targets.length === 0 ? (
            <p className="py-4 text-center text-sm text-gray-500">
              {t('list.empty')}
            </p>
          ) : (
            <ul className="divide-y divide-gray-200 dark:divide-gray-700">
              {targets.map((tg) => {
                const stopping =
                  remove.isPending && remove.variables === tg.egressId
                return (
                  <li
                    key={tg.id}
                    className="flex flex-wrap items-center gap-3 py-2.5"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                          {tg.name || platformLabel(tg.platform)}
                        </span>
                        <Badge tone="cyan">{platformLabel(tg.platform)}</Badge>
                        <Badge tone={STATUS_TONE[tg.status] ?? 'slate'}>
                          {t(`status.${tg.status}`, { defaultValue: tg.status })}
                        </Badge>
                        {tg.retries > 0 && (
                          <span className="text-[11px] text-gray-500 dark:text-gray-400">
                            {t('list.retries', { count: tg.retries })}
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 break-all font-mono text-[11px] text-gray-500 dark:text-gray-400">
                        {tg.urlMasked}
                      </p>
                      {tg.error && (
                        <p className="mt-0.5 text-[11px] text-red-500">{tg.error}</p>
                      )}
                    </div>
                    <Button
                      variant="danger"
                      disabled={stopping || !tg.egressId}
                      onClick={() => tg.egressId && remove.mutate(tg.egressId)}
                    >
                      {stopping ? t('actions.stopping') : t('actions.stop')}
                    </Button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>
    </Dialog>
  )
}
