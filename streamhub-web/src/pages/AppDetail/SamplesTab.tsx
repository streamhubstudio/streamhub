/**
 * Samples tab — embeddable snippets & deep links. Mints a viewer token
 * (POST /apps/:app/tokens) to obtain a player_url / embed_iframe, renders a
 * live preview, and exposes copyable embed code plus /player and /meeting links.
 */
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '@/api'
import type { MintedToken } from '@/api'
import {
  Button,
  Card,
  CopyField,
  ErrorBanner,
  Field,
  SectionTitle,
  TextInput,
  errMessage,
} from './ui'
import { SamplesManager } from './SamplesManager'

export function SamplesTab({ app }: { app: string }) {
  return (
    <div className="space-y-5">
      <SamplesManager app={app} />
      <EmbedGenerator app={app} />
    </div>
  )
}

function EmbedGenerator({ app }: { app: string }) {
  const { t } = useTranslation('samplesTab')
  const [room, setRoom] = useState('demo')

  const preview = useMutation<MintedToken>({
    mutationFn: () =>
      api.tokens.mint(app, {
        room: room.trim() || undefined,
        canPublish: false,
        canSubscribe: true,
      }),
  })

  const roomForLink = encodeURIComponent(room.trim() || 'demo')
  const playerPath = `/player/${encodeURIComponent(app)}/${roomForLink}`
  const meetingPath = `/meeting/${encodeURIComponent(app)}/${roomForLink}`
  const radioPath = `/radio/${encodeURIComponent(app)}/${roomForLink}`

  return (
    <div className="space-y-5">
      <Card>
        <SectionTitle
          title={t('embed.title')}
          subtitle={t('embed.subtitle')}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('embed.roomLabel')} hint={t('embed.roomHint')}>
            <TextInput value={room} placeholder="demo" onChange={(e) => setRoom(e.target.value)} />
          </Field>
          <div className="flex items-end">
            <Button variant="accent" disabled={preview.isPending} onClick={() => preview.mutate()}>
              {preview.isPending ? t('embed.generating') : t('embed.generate')}
            </Button>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-3">
          <Link
            to={playerPath}
            className="rounded-lg border border-navy-600 px-3 py-2 text-xs text-slate-300 transition hover:text-slate-100"
          >
            {t('embed.openPlayer')}
          </Link>
          <Link
            to={meetingPath}
            className="rounded-lg border border-navy-600 px-3 py-2 text-xs text-slate-300 transition hover:text-slate-100"
          >
            {t('embed.openMeeting')}
          </Link>
          <Link
            to={radioPath}
            className="rounded-lg border border-navy-600 px-3 py-2 text-xs text-slate-300 transition hover:text-slate-100"
          >
            {t('embed.openRadio')}
          </Link>
        </div>

        {preview.isError && (
          <div className="mt-4">
            <ErrorBanner message={errMessage(preview.error, t('embed.error'))} />
          </div>
        )}
      </Card>

      {preview.data && (
        <Card>
          <SectionTitle title={t('embed.snippetsTitle')} />
          <div className="space-y-3">
            {preview.data.embed_iframe && (
              <CopyField label={t('embed.embedIframe')} value={preview.data.embed_iframe} />
            )}
            {preview.data.player_url && (
              <CopyField label={t('embed.playerUrl')} value={preview.data.player_url} mono={false} />
            )}
            {!preview.data.embed_iframe && !preview.data.player_url && (
              <p className="text-xs text-slate-500">
                {t('embed.noEmbeddable')}
              </p>
            )}
          </div>

          {preview.data.player_url && (
            <div className="mt-5">
              <SectionTitle title={t('embed.livePreviewTitle')} />
              <div className="aspect-video w-full overflow-hidden rounded-lg border border-navy-600 bg-black">
                <iframe
                  src={preview.data.player_url}
                  title={`preview-${app}`}
                  allow="autoplay; fullscreen; picture-in-picture"
                  className="h-full w-full"
                />
              </div>
            </div>
          )}
        </Card>
      )}
    </div>
  )
}
