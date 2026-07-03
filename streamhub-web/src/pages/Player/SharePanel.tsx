/**
 * Share / embed panel for the Player.
 *
 * Prefers the canonical URLs minted by the API (`player_url`, `embed_iframe`),
 * falling back to URLs derived from the current origin + route params so the
 * panel still works if the backend omits them.
 */
import { useTranslation } from 'react-i18next'
import { Card } from '@/ui'
import { CopyField } from './CopyField'

interface SharePanelProps {
  app: string
  room: string
  /** From the minted token: server-provided public player URL, if any. */
  playerUrl?: string
  /** From the minted token: server-provided <iframe> snippet, if any. */
  embedIframe?: string
}

function buildIframe(url: string): string {
  return (
    `<iframe src="${url}" width="640" height="360" frameborder="0" ` +
    `allow="autoplay; fullscreen; picture-in-picture" allowfullscreen></iframe>`
  )
}

export function SharePanel({ app, room, playerUrl, embedIframe }: SharePanelProps) {
  const { t } = useTranslation('player')
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const slug = `${encodeURIComponent(app)}/${encodeURIComponent(room)}`
  // Public, no-login surfaces: /play (full player) + /embed (bare iframe).
  const publicUrl = playerUrl?.trim() || `${origin}/play/${slug}`
  const embedUrl = `${origin}/embed/${slug}`
  const iframe = embedIframe?.trim() || buildIframe(embedUrl)

  return (
    <Card>
      <h2 className="text-sm font-semibold text-fg">{t('share.title')}</h2>
      <p className="mt-0.5 text-xs text-fg-subtle">
        {t('share.subtitle')}
      </p>

      <div className="mt-4 space-y-4">
        <CopyField label={t('share.publicUrl')} value={publicUrl} />
        <CopyField label={t('share.embed')} value={iframe} multiline />
      </div>

      <a
        href={publicUrl}
        target="_blank"
        rel="noreferrer"
        className="mt-4 inline-flex items-center gap-1.5 text-xs font-medium text-primary-600 transition hover:text-primary-500 dark:text-primary-400 dark:hover:text-primary-300"
      >
        {t('share.openNewTab')}
        <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M14 5h5v5M19 5l-9 9M19 14v5H5V5h5" />
        </svg>
      </a>
    </Card>
  )
}
