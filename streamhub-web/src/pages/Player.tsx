/**
 * Player (/player/:app/:room) — full-screen low-latency WebRTC playback for a
 * single room.
 *
 * Wave 3: the connection + video + addons live entirely inside the reusable
 * <LivePlayer> component (it mints its own subscribe token and opens the
 * LiveKit connection). This page is just the full-screen chrome around it plus
 * the share / embed panel, since it renders OUTSIDE <AppLayout>.
 */
import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useParams } from 'react-router-dom'
import { LivePlayer } from '@/components/player'
import { SharePanel } from './Player/SharePanel'
import { Logo } from '@/components/Logo'

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-full items-center justify-center p-6">{children}</div>
  )
}

export default function Player() {
  const { t } = useTranslation('player')
  const { app, room } = useParams<{ app: string; room: string }>()
  const [audioOnly, setAudioOnly] = useState(false)

  if (!app || !room) {
    return (
      <Shell>
        <div className="glass max-w-md rounded-xl p-6 text-center">
          <h1 className="text-lg font-semibold text-fg">{t('invalid.title')}</h1>
          <p className="mt-1 text-sm text-slate-400">
            {t('invalid.desc')}
          </p>
        </div>
      </Shell>
    )
  }

  return (
    <div className="flex min-h-full flex-col">
      {/* Header chrome (full-screen page, no sidebar). */}
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-navy-600 bg-navy-800/70 px-4 py-3 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <Link to={`/apps/${encodeURIComponent(app)}`} className="shrink-0">
            <Logo className="h-7 w-auto" />
          </Link>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold text-fg">{room}</h1>
            <p className="truncate text-xs text-slate-500">{t('header.appLabel', { app })}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            role="switch"
            aria-checked={audioOnly}
            onClick={() => setAudioOnly((v) => !v)}
            className={[
              'inline-flex items-center gap-2 rounded-lg border px-3 py-1 text-xs transition',
              audioOnly
                ? 'border-blue2/40 bg-blue2/15 text-fg'
                : 'border-navy-600 text-slate-300 hover:text-fg',
            ].join(' ')}
            title={t('header.audioOnlyTitle')}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${audioOnly ? 'bg-sky2' : 'bg-navy-600'}`}
            />
            {t('header.audioOnly')}
          </button>
          <Link
            to={`/apps/${encodeURIComponent(app)}`}
            className="rounded-lg border border-navy-600 px-3 py-1 text-xs text-slate-300 transition hover:text-fg"
          >
            {t('header.exit')}
          </Link>
        </div>
      </header>

      {/* Stage + share. */}
      <main className="mx-auto grid w-full max-w-7xl flex-1 gap-5 p-4 sm:p-6 lg:grid-cols-[1fr_320px]">
        <LivePlayer
          app={app}
          room={room}
          audioOnly={audioOnly}
          audioLabel={room}
          addons={
            audioOnly
              ? { viewers: true }
              : { chat: true, reactions: true, viewers: true }
          }
          className="self-start"
        />
        <aside className="lg:max-w-[320px]">
          <SharePanel app={app} room={room} />
        </aside>
      </main>
    </div>
  )
}
