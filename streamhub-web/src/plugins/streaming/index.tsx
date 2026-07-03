/**
 * Video Streaming plugin (frontend) — an installable TOOL surfaced as an APP TAB.
 *
 * Auto-discovered by src/plugins/discovery.ts. When installed + active,
 * AppDetail's <PluginSlot placement="app-tab"> mounts <StreamingTab> inside the
 * app. It reuses the exact Studio publish lifecycle (usePublisher: webcam + mic
 * → WebRTC publish → server room-composite egress → RTMP) so an operator can go
 * live to YouTube/Twitch/… without leaving the app. The full-screen Studio page
 * (/broadcast/:app) remains available for advanced use.
 *
 * Config pre-fills the destination RTMP URL, room and audio-only default.
 */
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Trans, useTranslation } from 'react-i18next'
import {
  Banner,
  DeviceSelect,
  Duration,
  EgressStatus,
  Field,
  PhaseBadge,
  TextInput,
} from '@/pages/Broadcast/ui'
import { usePublisher } from '@/pages/Broadcast/usePublisher'
import { Button, Spinner, Switcher } from '@/ui'
import { definePlugin } from '../types.ts'
import type { PluginComponentProps } from '../types.ts'
import {
  isRtmpValid,
  resolveAudioOnly,
  resolveRoom,
  resolveRtmpUrl,
} from './logic.ts'

const RTMP_PLACEHOLDER = 'rtmp://a.rtmp.youtube.com/live2/<stream-key>'

function StreamingTab({ ctx }: PluginComponentProps) {
  const { t } = useTranslation(['streaming', 'broadcast'])
  const app = ctx.app ?? ''
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

  const [rtmpUrl, setRtmpUrl] = useState(() => resolveRtmpUrl(ctx.config))
  const [roomName] = useState(() => resolveRoom(ctx.config))
  const videoRef = useRef<HTMLVideoElement | null>(null)

  // Apply the audio-only default from config once on mount.
  const appliedDefault = useRef(false)
  useEffect(() => {
    if (appliedDefault.current) return
    appliedDefault.current = true
    if (resolveAudioOnly(ctx.config)) setAudioOnly(true)
  }, [ctx.config, setAudioOnly])

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

  if (!app) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800 p-6 text-center">
        <p className="text-sm text-gray-500 dark:text-gray-400">{t('streaming:invalid')}</p>
      </div>
    )
  }

  const isLive = state.phase === 'live'
  const isBusy = state.phase === 'connecting' || state.phase === 'stopping'
  const formLocked = isLive || isBusy
  const rtmpLooksValid = isRtmpValid(rtmpUrl)
  const canStart =
    state.phase === 'idle' &&
    rtmpLooksValid &&
    (state.audioOnly || state.permission !== 'denied')

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
      {/* Preview */}
      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-gray-500 dark:text-gray-400">{t('streaming:subtitle')}</p>
          <Link
            to={`/broadcast/${encodeURIComponent(app)}`}
            className="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-1.5 text-xs text-gray-600 dark:text-gray-300 transition hover:text-fg"
          >
            {t('streaming:openStudio')}
          </Link>
        </div>

        <div className="relative aspect-video w-full overflow-hidden rounded-xl border border-gray-200 dark:border-gray-700 bg-black">
          <video ref={videoRef} autoPlay playsInline muted className="h-full w-full object-contain" />
          <div className="pointer-events-none absolute left-3 top-3">
            {(isLive || state.phase === 'connecting') && <PhaseBadge phase={state.phase} />}
          </div>
          {!state.previewTrack && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center text-gray-500 dark:text-gray-400">
              {state.audioOnly ? (
                <>
                  <svg className="h-10 w-10 text-primary-500" fill="none" stroke="currentColor" strokeWidth={1.6} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 15a3 3 0 003-3V6a3 3 0 00-6 0v6a3 3 0 003 3zM19 12a7 7 0 01-14 0M12 19v3" />
                  </svg>
                  <p className="text-sm">{t('broadcast:preview.audioOnly')}</p>
                  <p className="max-w-xs text-xs text-gray-500 dark:text-gray-400">{t('broadcast:preview.audioOnlyHint')}</p>
                </>
              ) : state.permission === 'denied' ? (
                <>
                  <p className="text-sm">{t('broadcast:preview.permissionDenied')}</p>
                  <p className="max-w-xs text-xs text-gray-500 dark:text-gray-400">{t('broadcast:preview.permissionHint')}</p>
                  <Button variant="default" size="sm" className="mt-1" onClick={retryPermission}>
                    {t('broadcast:preview.retryPermission')}
                  </Button>
                </>
              ) : (
                <>
                  <Spinner size={28} />
                  <p className="text-xs">{t('broadcast:preview.initializing')}</p>
                </>
              )}
            </div>
          )}
        </div>

        <p className="text-[11px] leading-snug text-gray-500 dark:text-gray-400">
          <Trans i18nKey="broadcast:preview.note" components={{ strong: <strong /> }} />
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

        <div className="rounded-2xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800 p-4 sm:p-5">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-fg">{t('broadcast:form.title')}</h2>
            <div className="flex items-center gap-2">
              {state.startedAt && (
                <span className="rounded-md bg-gray-100 dark:bg-gray-700 px-2 py-1 text-xs text-gray-600 dark:text-gray-300">
                  <Duration since={state.startedAt} />
                </span>
              )}
              <PhaseBadge phase={state.phase} />
            </div>
          </div>

          <div className="mt-4 space-y-4">
            <div className="flex items-center justify-between gap-4 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-700/40 px-4 py-3">
              <div>
                <div className="text-sm text-fg">{t('broadcast:form.audioOnly')}</div>
                <div className="mt-0.5 text-[11px] text-gray-500 dark:text-gray-400">{t('broadcast:form.audioOnlyHint')}</div>
              </div>
              <Switcher
                checked={state.audioOnly}
                disabled={formLocked}
                onChange={(val) => setAudioOnly(val)}
              />
            </div>

            <Field
              label={t('broadcast:form.rtmpLabel')}
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
              <p className="-mt-2 text-[11px] text-amber-600 dark:text-amber-400">{t('broadcast:form.rtmpInvalid')}</p>
            )}

            {!state.audioOnly && (
              <Field label={t('broadcast:form.cameraLabel')}>
                <DeviceSelect
                  devices={state.cameras}
                  value={state.cameraId}
                  onChange={selectCamera}
                  disabled={formLocked}
                  emptyLabel={t('broadcast:form.cameraEmpty')}
                />
              </Field>
            )}

            <Field label={t('broadcast:form.micLabel')}>
              <DeviceSelect
                devices={state.mics}
                value={state.micId}
                onChange={selectMic}
                disabled={formLocked}
                emptyLabel={t('broadcast:form.micEmpty')}
              />
            </Field>
          </div>
        </div>

        {state.egress && (
          <div className="flex border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800 items-center justify-between rounded-2xl px-4 py-3 text-sm">
            <div className="min-w-0">
              <p className="text-xs text-gray-500 dark:text-gray-400">{t('broadcast:egress.label')}</p>
              <p className="truncate font-mono text-xs text-gray-600 dark:text-gray-300">{state.egress.id}</p>
            </div>
            <EgressStatus status={state.egress.status} />
          </div>
        )}

        {!isLive ? (
          <Button
            variant="solid"
            block
            onClick={() => start(rtmpUrl, roomName)}
            disabled={!canStart}
          >
            {state.phase === 'connecting' ? t('broadcast:actions.connecting') : t('broadcast:actions.start')}
          </Button>
        ) : (
          <Button
            variant="solid"
            color="red-500"
            block
            onClick={stop}
            disabled={state.phase === 'stopping'}
          >
            {state.phase === 'stopping' ? t('broadcast:actions.stopping') : t('broadcast:actions.stop')}
          </Button>
        )}

        {!rtmpLooksValid && state.phase === 'idle' && (
          <p className="text-center text-[11px] text-gray-500 dark:text-gray-400">{t('broadcast:actions.needValidUrl')}</p>
        )}
      </aside>
    </div>
  )
}

export default definePlugin({
  id: 'streaming',
  name: 'Video Streaming',
  description:
    'Go live with your webcam + mic and forward the composed room to an RTMP ' +
    'destination (YouTube, Twitch, …) via server egress.',
  category: 'tool',
  ui: 'app-tab',
  version: '1.0.0',
  icon: 'M15 10l4.5-2.5v9L15 14M3 7h12v10H3z',
  configSchema: {
    fields: [
      {
        key: 'room',
        type: 'string',
        label: 'Room name',
        default: 'studio',
        placeholder: 'studio',
        description: 'LiveKit room the webcam publishes to and the egress composes.',
      },
      {
        key: 'defaultRtmpUrl',
        type: 'string',
        label: 'Default RTMP URL',
        default: '',
        placeholder: RTMP_PLACEHOLDER,
        description: 'Optional. Pre-fills the destination (rtmp:// or rtmps://).',
      },
      {
        key: 'audioOnly',
        type: 'boolean',
        label: 'Audio-only by default',
        default: false,
      },
    ],
  },
  TabComponent: StreamingTab,
})
