/**
 * Meeting (/meeting/:app/:room) — full-screen multi-party WebRTC room.
 *
 * Flow:
 *  1. Pre-join card (display name + camera/mic defaults).
 *  2. Mint a publish+subscribe join token via `api.tokens.mint`.
 *  3. Connect with <LiveKitRoom> and render the participant grid + publish
 *     controls, with the shared <PlayerAddons> overlay (chat / reactions /
 *     viewers) layered on top.
 *
 * Wave 3: chat / reactions / viewers come from the reusable <PlayerAddons>
 * component (same one the live <LivePlayer> uses), so the meeting only owns the
 * grid and the publish controls (mic / cam / screen / leave).
 */
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Track } from 'livekit-client'
import {
  DisconnectButton,
  GridLayout,
  LiveKitRoom,
  ParticipantTile,
  RoomAudioRenderer,
  TrackToggle,
  useLocalParticipant,
  useTracks,
} from '@livekit/components-react'
import '@livekit/components-styles'
import { api, ApiRequestError } from '@/api'
import { PlayerAddons, ViewerBadge } from '@/components/player'
import PreJoin, { type JoinChoices } from './Meeting/PreJoin'

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-950 p-6 text-center">
      {children}
    </div>
  )
}

// --- in-room stage ----------------------------------------------------------

const btnBase =
  'flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl px-3 py-2.5 text-sm font-medium transition sm:min-h-0 sm:flex-none'

function toggleClass(active: boolean): string {
  return [
    btnBase,
    active
      ? 'bg-gray-800 text-fg ring-1 ring-gray-700'
      : 'bg-red-500/15 text-danger ring-1 ring-red-500/30',
  ].join(' ')
}

function Icon({ d }: { d: string }) {
  return (
    <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d={d} />
    </svg>
  )
}

function MeetingStage({
  app,
  room,
  identity,
  onError,
}: {
  app: string
  room: string
  identity?: string
  onError: (err: Error) => void
}) {
  const { t } = useTranslation('meeting')
  const { isMicrophoneEnabled, isCameraEnabled, isScreenShareEnabled } =
    useLocalParticipant()

  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { onlySubscribed: false },
  )

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-gray-800 bg-gray-900/80 px-4 py-3">
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold text-fg">{room}</h1>
          <p className="truncate text-xs text-gray-500">{app}</p>
        </div>
        <ViewerBadge />
      </header>

      {/* Stage + addons overlay */}
      <div className="relative min-h-0 flex-1 bg-gray-900/40">
        {tracks.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-gray-500">
            {t('stage.waiting')}
          </div>
        ) : (
          <GridLayout tracks={tracks} className="h-full">
            <ParticipantTile />
          </GridLayout>
        )}

        <PlayerAddons
          features={{ chat: true, reactions: true, viewers: false }}
          identity={identity}
          onError={onError}
          controlsAnchor="bottom-right"
        />
      </div>

      {/* Publish controls — big, tappable, single row on mobile. */}
      <div className="flex items-center justify-center gap-2 border-t border-gray-800 bg-gray-900/80 px-3 py-3 sm:flex-wrap sm:px-4">
        <TrackToggle
          source={Track.Source.Microphone}
          showIcon={false}
          onDeviceError={onError}
          className={toggleClass(isMicrophoneEnabled)}
        >
          <Icon
            d={
              isMicrophoneEnabled
                ? 'M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3zM5 10v2a7 7 0 0014 0v-2M12 19v4'
                : 'M5 10v2a7 7 0 0010.5 6.06M9 9.3V4a3 3 0 016 0v6M3 3l18 18'
            }
          />
          <span className="hidden sm:inline">
            {isMicrophoneEnabled ? t('controls.micOn') : t('controls.micOff')}
          </span>
        </TrackToggle>

        <TrackToggle
          source={Track.Source.Camera}
          showIcon={false}
          onDeviceError={onError}
          className={toggleClass(isCameraEnabled)}
        >
          <Icon
            d={
              isCameraEnabled
                ? 'M15 10l4.5-2.5v9L15 14M3 7h12v10H3z'
                : 'M3 3l18 18M15 10l4.5-2.5v9M10 7h5v6'
            }
          />
          <span className="hidden sm:inline">
            {isCameraEnabled ? t('controls.camOn') : t('controls.camOff')}
          </span>
        </TrackToggle>

        <TrackToggle
          source={Track.Source.ScreenShare}
          showIcon={false}
          onDeviceError={onError}
          className={[
            btnBase,
            isScreenShareEnabled
              ? 'bg-primary-500/20 text-fg ring-1 ring-primary-400/40'
              : 'bg-gray-800 text-gray-300 ring-1 ring-gray-700 hover:text-fg',
          ].join(' ')}
        >
          <Icon d="M4 5h16v10H4zM8 19h8M12 15v4" />
          <span className="hidden sm:inline">{t('controls.screen')}</span>
        </TrackToggle>

        <DisconnectButton
          className={[btnBase, 'bg-red-500/90 text-white hover:bg-red-500'].join(' ')}
        >
          <Icon d="M17 16l4-4m0 0l-4-4m4 4H7M13 16v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
          <span className="hidden sm:inline">{t('controls.leave')}</span>
        </DisconnectButton>
      </div>

      {/* Remote audio playback. */}
      <RoomAudioRenderer />
    </div>
  )
}

// --- page -------------------------------------------------------------------

export default function Meeting() {
  const { t } = useTranslation(['meeting', 'common'])
  const { app, room } = useParams()
  const navigate = useNavigate()
  const [choices, setChoices] = useState<JoinChoices | null>(null)
  const [connectError, setConnectError] = useState<string | null>(null)

  const leave = useCallback(() => {
    if (app) navigate(`/apps/${app}`)
    else navigate('/')
  }, [app, navigate])

  const tokenQuery = useQuery({
    queryKey: ['meeting-token', app, room, choices?.name],
    enabled: Boolean(app && room && choices),
    staleTime: 5 * 60 * 1000,
    retry: 1,
    queryFn: () =>
      api.tokens.mint(app as string, {
        room: room as string,
        name: choices?.name || undefined,
        canPublish: true,
        canSubscribe: true,
      }),
  })

  const handleJoin = useCallback((c: JoinChoices) => {
    setConnectError(null)
    setChoices(c)
  }, [])

  const handleConnectError = useCallback((err: Error) => {
    setConnectError(err.message || t('token.connectError'))
    setChoices(null)
  }, [t])

  // --- guards ---------------------------------------------------------------
  if (!app || !room) {
    return (
      <Centered>
        <div>
          <h1 className="text-xl font-semibold text-fg">{t('invalid.title')}</h1>
          <p className="mt-1 text-sm text-gray-400">
            {t('invalid.desc')}
          </p>
        </div>
      </Centered>
    )
  }

  // --- pre-join (or after a connection error) -------------------------------
  if (!choices) {
    return (
      <div className="min-h-screen bg-gray-950">
        {connectError && (
          <div className="mx-auto max-w-md px-6 pt-6">
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-danger">
              {connectError}
            </div>
          </div>
        )}
        <PreJoin
          app={app}
          room={room}
          connecting={tokenQuery.isFetching}
          onJoin={handleJoin}
        />
      </div>
    )
  }

  // --- minting token --------------------------------------------------------
  if (tokenQuery.isLoading || (!tokenQuery.data && !tokenQuery.isError)) {
    return (
      <Centered>
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-800 border-t-primary-500" />
          <p className="text-sm text-gray-400">{t('token.minting')}</p>
        </div>
      </Centered>
    )
  }

  // --- token error ----------------------------------------------------------
  if (tokenQuery.isError || !tokenQuery.data) {
    const message =
      tokenQuery.error instanceof ApiRequestError
        ? tokenQuery.error.message
        : t('token.error')
    return (
      <Centered>
        <div className="max-w-md bg-gray-900/90 ring-1 ring-white/10 backdrop-blur rounded-2xl p-6">
          <h1 className="text-lg font-semibold text-fg">{t('token.joinFailed')}</h1>
          <p className="mt-1 text-sm text-warn">{message}</p>
          <div className="mt-5 flex justify-center gap-3">
            <button
              onClick={() => setChoices(null)}
              className="rounded-lg border border-gray-800 px-4 py-2 text-sm text-gray-300 transition hover:text-fg"
            >
              {t('common:actions.back')}
            </button>
            <button
              onClick={() => tokenQuery.refetch()}
              className="bg-primary-500 text-white hover:bg-primary-600 rounded-lg px-4 py-2 text-sm font-medium"
            >
              {t('common:actions.retry')}
            </button>
          </div>
        </div>
      </Centered>
    )
  }

  // --- connected room -------------------------------------------------------
  const minted = tokenQuery.data
  return (
    <div className="h-screen bg-gray-950">
      <LiveKitRoom
        serverUrl={minted.wsUrl}
        token={minted.token}
        connect
        audio={choices.audio}
        video={choices.video}
        onDisconnected={leave}
        onError={handleConnectError}
        className="h-full"
      >
        <MeetingStage
          app={app}
          room={room}
          identity={choices.name || undefined}
          onError={handleConnectError}
        />
      </LiveKitRoom>
    </div>
  )
}
