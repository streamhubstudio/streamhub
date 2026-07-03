/**
 * Radio (/radio/:app/:room) — WebRTC radio máster + listener tooling (spec §6).
 *
 *  - Máster: "Salir al aire" publishes the mic (audio-only) via useRadioMaster.
 *    Shows the live listener count and an on-air timer.
 *  - Listener preview: a subscribe-only audio player (<LivePlayer audioOnly>) so
 *    the operator hears what the oyentes hear (EN VIVO badge + counter).
 *  - Embed/share: a copyable listener iframe (served audio-radio.html sample),
 *    plus an on-demand subscribe-only "listen token" for custom integrations.
 *
 * Full-screen surface (no <AppLayout> sidebar), matching Player/Broadcast.
 */
import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Trans, useTranslation } from 'react-i18next'
import { useMutation } from '@tanstack/react-query'
import { api } from '@/api'
import { Button } from '@/ui'
import { LivePlayer } from '@/components/player'
import {
  Banner,
  DeviceSelect,
  Duration,
  Field,
  PhaseBadge,
  TextInput,
} from './Broadcast/ui'
import { useRadioMaster } from './Radio/useRadioMaster'
import { Logo } from '@/components/Logo'

function CopyRow({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  const { t } = useTranslation('common')
  const [copied, setCopied] = useState(false)
  function copy() {
    navigator.clipboard?.writeText(value).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <div>
      <span className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">{label}</span>
      <div className="flex items-center gap-2">
        <input
          readOnly
          value={value}
          onFocus={(e) => e.currentTarget.select()}
          className={`w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-100 dark:bg-gray-700 px-3 py-2 text-sm text-fg ${
            mono ? 'font-mono text-xs' : ''
          }`}
        />
        <Button variant="default" size="sm" onClick={copy} className="shrink-0">
          {copied ? t('actions.copied') : t('actions.copy')}
        </Button>
      </div>
    </div>
  )
}

export default function Radio() {
  const { t } = useTranslation('radio')
  const { app = '', room = '' } = useParams<{ app: string; room: string }>()
  const navigate = useNavigate()
  const { state, start, stop, selectMic, clearError } = useRadioMaster(app, room)

  const [roomDraft, setRoomDraft] = useState(room)
  const listenToken = useMutation({
    mutationFn: () => api.apps.radioListenToken(app, room),
  })

  if (!app || !room) {
    return (
      <div className="flex min-h-full items-center justify-center p-6">
        <div className="max-w-md rounded-xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800 p-6 text-center">
          <h1 className="text-lg font-semibold text-fg">{t('invalid.title')}</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{t('invalid.message')}</p>
        </div>
      </div>
    )
  }

  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const listenerUrl = `${origin}/samples/${encodeURIComponent(app)}/audio-radio.html?room=${encodeURIComponent(room)}`
  const embed = `<iframe src="${listenerUrl}" width="360" height="120" allow="autoplay" style="border:0"></iframe>`

  const isLive = state.phase === 'live'
  const isBusy = state.phase === 'connecting' || state.phase === 'stopping'

  function changeRoom() {
    const next = roomDraft.trim()
    if (next && next !== room) {
      navigate(`/radio/${encodeURIComponent(app)}/${encodeURIComponent(next)}`)
    }
  }

  return (
    <div className="flex min-h-full flex-col">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-4 py-3 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <Link to={`/apps/${encodeURIComponent(app)}`} className="shrink-0">
            <Logo className="h-7 w-auto" />
          </Link>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold text-fg">
              {t('header.title', { room })}
            </h1>
            <p className="truncate text-xs text-gray-500 dark:text-gray-400">
              {t('header.subtitle', { app })}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <PhaseBadge phase={state.phase} />
          {state.startedAt && (
            <span className="rounded-md bg-gray-100 dark:bg-gray-700 px-2 py-1 text-xs text-gray-600 dark:text-gray-300">
              <Duration since={state.startedAt} />
            </span>
          )}
          <Link
            to={`/apps/${encodeURIComponent(app)}`}
            className="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-1 text-xs text-gray-600 dark:text-gray-300 transition hover:text-fg"
          >
            {t('header.exit')}
          </Link>
        </div>
      </header>

      <main className="mx-auto grid w-full max-w-6xl flex-1 gap-5 p-4 sm:p-6 lg:grid-cols-[1fr_360px]">
        {/* Máster + monitor */}
        <section className="flex flex-col gap-5">
          <div className="rounded-2xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800 p-4 sm:p-5">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-fg">{t('master.title')}</h2>
              <span className="inline-flex items-center gap-1.5 rounded-full bg-gray-100 dark:bg-gray-700 px-3 py-1 text-xs font-medium text-gray-700 dark:text-gray-200 ring-1 ring-gray-200 dark:ring-gray-700">
                <span className={`h-1.5 w-1.5 rounded-full ${isLive ? 'animate-pulse bg-primary-500' : 'bg-gray-300 dark:bg-gray-600'}`} />
                {t('master.listeners', { count: state.listeners })}
              </span>
            </div>

            {state.error && (
              <div className="mt-4">
                <Banner tone="error" onClose={clearError}>
                  {state.error}
                </Banner>
              </div>
            )}

            <div className="mt-4 space-y-4">
              <Field label={t('master.micLabel')}>
                <DeviceSelect
                  devices={state.mics}
                  value={state.micId}
                  onChange={selectMic}
                  disabled={isLive || isBusy}
                  emptyLabel={t('master.micEmpty')}
                />
              </Field>

              {!isLive ? (
                <Button
                  variant="solid"
                  block
                  onClick={start}
                  disabled={isBusy || state.permission === 'denied'}
                >
                  {state.phase === 'connecting' ? t('master.goingLive') : t('master.goLive')}
                </Button>
              ) : (
                <Button
                  variant="solid"
                  color="red-500"
                  block
                  onClick={stop}
                  disabled={state.phase === 'stopping'}
                >
                  {state.phase === 'stopping' ? t('master.goingOff') : t('master.goOff')}
                </Button>
              )}
              {state.permission === 'denied' && (
                <p className="text-center text-[11px] text-amber-600 dark:text-amber-400">
                  {t('master.permissionDenied')}
                </p>
              )}
            </div>
            <p className="mt-4 text-[11px] leading-snug text-gray-500 dark:text-gray-400">
              <Trans
                i18nKey="radio:master.note"
                components={{ strong: <strong /> }}
              />
            </p>
          </div>

          {/* Listener monitor — counts as one oyente while abierto. */}
          <div className="rounded-2xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800 p-4 sm:p-5">
            <h2 className="mb-3 text-sm font-semibold text-fg">{t('monitor.title')}</h2>
            <LivePlayer
              app={app}
              room={room}
              audioOnly
              audioLabel={t('monitor.audioLabel', { room })}
              addons={{ viewers: true }}
            />
            <p className="mt-2 text-[11px] text-gray-500 dark:text-gray-400">{t('monitor.note')}</p>
          </div>
        </section>

        {/* Share / embed */}
        <aside className="flex flex-col gap-4">
          <div className="rounded-2xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800 p-4 sm:p-5">
            <h2 className="text-sm font-semibold text-fg">{t('share.title')}</h2>
            <div className="mt-4 space-y-4">
              <CopyRow label={t('share.listenerLink')} value={listenerUrl} mono={false} />
              <CopyRow label={t('share.embed')} value={embed} />
              <p className="text-[11px] leading-snug text-gray-500 dark:text-gray-400">
                <Trans
                  i18nKey="radio:share.note"
                  components={{ strong: <strong /> }}
                />
              </p>
            </div>
          </div>

          <div className="rounded-2xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800 p-4 sm:p-5">
            <h2 className="text-sm font-semibold text-fg">{t('token.title')}</h2>
            <p className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">
              <Trans
                i18nKey="radio:token.subtitle"
                components={{ strong: <strong /> }}
              />
            </p>
            <Button
              variant="default"
              block
              className="mt-3"
              onClick={() => listenToken.mutate()}
              disabled={listenToken.isPending}
            >
              {listenToken.isPending ? t('token.generating') : t('token.generate')}
            </Button>
            {listenToken.isError && (
              <p className="mt-2 text-[11px] text-amber-600 dark:text-amber-400">{t('token.error')}</p>
            )}
            {listenToken.data && (
              <div className="mt-3 space-y-3">
                <CopyRow label={t('token.jwt')} value={listenToken.data.token} />
                <CopyRow label={t('token.wsUrl')} value={listenToken.data.wsUrl} />
              </div>
            )}
          </div>

          <div className="rounded-2xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800 p-4 sm:p-5">
            <h2 className="text-sm font-semibold text-fg">{t('room.title')}</h2>
            <div className="mt-3 flex items-end gap-2">
              <div className="flex-1">
                <Field label={t('room.nameLabel')}>
                  <TextInput
                    value={roomDraft}
                    onChange={(e) => setRoomDraft(e.target.value)}
                    placeholder="radio"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') changeRoom()
                    }}
                  />
                </Field>
              </div>
              <Button variant="default" onClick={changeRoom} className="mb-0.5">
                {t('room.change')}
              </Button>
            </div>
          </div>
        </aside>
      </main>
    </div>
  )
}
