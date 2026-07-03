/**
 * Broadcast / Studio (/broadcast/:app) — publish the user's WEBCAM + MIC to an
 * RTMP destination (YouTube, Twitch, …) via WebRTC -> LiveKit -> server egress.
 *
 * Flow (see usePublisher):
 *   1. The browser CONNECTS and PUBLISHES camera+mic to the room (livekit-client,
 *      using a publish token from POST /apps/:app/tokens { room, canPublish:true }).
 *   2. ONLY THEN it calls POST /apps/:app/broadcast/start { roomName, rtmpUrl } so
 *      the room-composite egress renders the room and pushes it to the RTMP URL.
 * Stop = POST /apps/:app/broadcast/:id/stop + disconnect + release the mic.
 *
 * The browser does NOT push RTMP directly: it speaks WebRTC and the SERVER
 * forwards the composed stream to RTMP.
 *
 * Full-screen surface (no <AppLayout> sidebar) — ships its own header chrome,
 * matching Player/Meeting. Theme tokens per src/index.css.
 */
import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Trans, useTranslation } from 'react-i18next'
import {
  Banner,
  DeviceSelect,
  Duration,
  EgressStatus,
  Field,
  PhaseBadge,
  TextInput,
} from './Broadcast/ui'
import { isValidRtmpUrl, usePublisher } from './Broadcast/usePublisher'
import { Button, Card, Spinner, Switcher } from '@/ui'
import { Logo } from '@/components/Logo'

const RTMP_PLACEHOLDER = 'rtmp://a.rtmp.youtube.com/live2/<stream-key>'

export default function Broadcast() {
  const { t } = useTranslation('broadcast')
  const { app = 'live' } = useParams<{ app: string }>()
  const {
    state,
    start,
    stop,
    selectCamera,
    selectMic,
    setAudioOnly,
    retryPermission,
    clearError,
    clearWarning,
  } = usePublisher(app)

  const [rtmpUrl, setRtmpUrl] = useState('')
  const [roomName, setRoomName] = useState('studio')
  const videoRef = useRef<HTMLVideoElement | null>(null)

  // Attach/detach the local preview track to the <video> element.
  useEffect(() => {
    const el = videoRef.current
    const track = state.previewTrack
    if (!el || !track) return
    track.attach(el)
    return () => {
      track.detach(el)
    }
  }, [state.previewTrack])

  const isLive = state.phase === 'live'
  const isBusy = state.phase === 'connecting' || state.phase === 'stopping'
  const formLocked = isLive || isBusy
  const rtmpLooksValid = isValidRtmpUrl(rtmpUrl)
  const canStart =
    state.phase === 'idle' &&
    rtmpLooksValid &&
    (state.audioOnly || state.permission !== 'denied')

  return (
    <div className="flex min-h-full flex-col">
      {/* Header chrome */}
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-200 bg-white/70 px-4 py-3 sm:px-6 dark:border-gray-700 dark:bg-gray-800/70">
        <div className="flex min-w-0 items-center gap-3">
          <Link to={`/apps/${encodeURIComponent(app)}`} className="shrink-0">
            <Logo className="h-7 w-auto" />
          </Link>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold text-fg">
              {t('header.title')}
            </h1>
            <p className="truncate text-xs text-gray-500 dark:text-gray-400">
              {t('header.subtitle', { app })}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <PhaseBadge phase={state.phase} />
          {state.startedAt && (
            <span className="rounded-md bg-gray-100 px-2 py-1 text-xs text-gray-600 dark:bg-gray-700 dark:text-gray-200">
              <Duration since={state.startedAt} />
            </span>
          )}
          <Link to={`/apps/${encodeURIComponent(app)}`}>
            <Button size="xs" variant="default">
              {t('header.exit')}
            </Button>
          </Link>
        </div>
      </header>

      <main className="mx-auto grid w-full max-w-6xl flex-1 gap-5 p-4 sm:p-6 lg:grid-cols-[1fr_360px]">
        {/* Preview */}
        <section className="flex flex-col gap-3">
          <div className="relative aspect-video w-full overflow-hidden rounded-xl border border-gray-200 bg-black dark:border-gray-700">
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className="h-full w-full object-contain"
            />
            {/* Live overlay */}
            <div className="pointer-events-none absolute left-3 top-3">
              {(isLive || state.phase === 'connecting') && (
                <PhaseBadge phase={state.phase} />
              )}
            </div>
            {/* No-preview placeholder */}
            {!state.previewTrack && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center text-gray-500 dark:text-gray-400">
                {state.audioOnly ? (
                  <>
                    <svg className="h-10 w-10 text-primary-500" fill="none" stroke="currentColor" strokeWidth={1.6} viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 15a3 3 0 003-3V6a3 3 0 00-6 0v6a3 3 0 003 3zM19 12a7 7 0 01-14 0M12 19v3" />
                    </svg>
                    <p className="text-sm">{t('preview.audioOnly')}</p>
                    <p className="max-w-xs text-xs text-gray-500 dark:text-gray-400">
                      {t('preview.audioOnlyHint')}
                    </p>
                  </>
                ) : state.permission === 'denied' ? (
                  <>
                    <p className="text-sm">{t('preview.permissionDenied')}</p>
                    <p className="max-w-xs text-xs text-gray-500 dark:text-gray-400">
                      {t('preview.permissionHint')}
                    </p>
                    <span className="mt-1 inline-flex">
                      <Button size="xs" variant="default" onClick={retryPermission}>
                        {t('preview.retryPermission')}
                      </Button>
                    </span>
                  </>
                ) : (
                  <>
                    <Spinner size={28} />
                    <p className="text-xs">{t('preview.initializing')}</p>
                  </>
                )}
              </div>
            )}
          </div>

          <p className="text-[11px] leading-snug text-gray-500 dark:text-gray-400">
            <Trans
              i18nKey="broadcast:preview.note"
              components={{ strong: <strong /> }}
            />
          </p>
        </section>

        {/* Controls */}
        <aside className="flex flex-col gap-4">
          {state.error && (
            <Banner tone="error" onClose={clearError}>
              {state.error}
            </Banner>
          )}
          {state.warning && (
            <Banner tone="warning" onClose={clearWarning}>
              {state.warning}
            </Banner>
          )}

          <Card bordered bodyClass="p-4 sm:p-5" className="rounded-2xl">
            <h2 className="text-sm font-semibold text-fg">{t('form.title')}</h2>

            <div className="mt-4 space-y-4">
              <div className="flex items-center justify-between gap-4 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 dark:border-gray-600 dark:bg-gray-700/40">
                <div>
                  <div className="text-sm text-fg">{t('form.audioOnly')}</div>
                  <div className="mt-0.5 text-[11px] text-gray-500 dark:text-gray-400">
                    {t('form.audioOnlyHint')}
                  </div>
                </div>
                <Switcher
                  checked={state.audioOnly}
                  disabled={formLocked}
                  onChange={(val) => setAudioOnly(val)}
                />
              </div>

              <Field
                label={t('form.rtmpLabel')}
                hint={
                  <Trans
                    i18nKey="broadcast:form.rtmpHint"
                    values={{ url: RTMP_PLACEHOLDER }}
                    components={{ em: <em />, code: <span className="font-mono" /> }}
                  />
                }
              >
                <TextInput
                  value={rtmpUrl}
                  onChange={(e) => setRtmpUrl(e.target.value)}
                  placeholder={RTMP_PLACEHOLDER}
                  disabled={formLocked}
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>
              {rtmpUrl.length > 0 && !rtmpLooksValid && (
                <p className="-mt-2 text-[11px] text-amber-600 dark:text-amber-400">
                  {t('form.rtmpInvalid')}
                </p>
              )}

              <Field label={t('form.roomLabel')} hint={t('form.roomHint')}>
                <TextInput
                  value={roomName}
                  onChange={(e) => setRoomName(e.target.value)}
                  placeholder="studio"
                  disabled={formLocked}
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>

              {!state.audioOnly && (
                <Field label={t('form.cameraLabel')}>
                  <DeviceSelect
                    devices={state.cameras}
                    value={state.cameraId}
                    onChange={selectCamera}
                    disabled={formLocked}
                    emptyLabel={t('form.cameraEmpty')}
                  />
                </Field>
              )}

              <Field label={t('form.micLabel')}>
                <DeviceSelect
                  devices={state.mics}
                  value={state.micId}
                  onChange={selectMic}
                  disabled={formLocked}
                  emptyLabel={t('form.micEmpty')}
                />
              </Field>
            </div>
          </Card>

          {/* Egress status */}
          {state.egress && (
            <Card bordered bodyClass="flex items-center justify-between px-4 py-3 text-sm" className="rounded-2xl">
              <div className="min-w-0">
                <p className="text-xs text-gray-500 dark:text-gray-400">{t('egress.label')}</p>
                <p className="truncate font-mono text-xs text-gray-600 dark:text-gray-300">
                  {state.egress.id}
                </p>
              </div>
              <EgressStatus status={state.egress.status} />
            </Card>
          )}

          {/* Actions */}
          {!isLive ? (
            <Button
              block
              variant="solid"
              className="py-3 text-sm font-semibold"
              onClick={() => start(rtmpUrl, roomName)}
              disabled={!canStart}
            >
              {state.phase === 'connecting' ? t('actions.connecting') : t('actions.start')}
            </Button>
          ) : (
            <Button
              block
              variant="solid"
              color="red-600"
              className="py-3 text-sm font-semibold"
              onClick={stop}
              disabled={state.phase === 'stopping'}
            >
              {state.phase === 'stopping' ? t('actions.stopping') : t('actions.stop')}
            </Button>
          )}

          {!rtmpLooksValid && state.phase === 'idle' && (
            <p className="text-center text-[11px] text-gray-500 dark:text-gray-400">
              {t('actions.needValidUrl')}
            </p>
          )}
        </aside>
      </main>
    </div>
  )
}
