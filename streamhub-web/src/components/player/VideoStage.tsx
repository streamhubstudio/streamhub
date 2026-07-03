/**
 * Video surface for the subscriber player. Renders the camera + screen-share
 * tracks published in the room in a responsive grid, handling the three
 * meaningful states:
 *   - connecting        → spinner
 *   - connected, no pub → empty-room placeholder (waiting for a broadcaster)
 *   - connected, tracks → the video grid
 *
 * Must live inside <LiveKitRoom>. Audio playback is handled separately by the
 * parent (<RoomAudioRenderer>) so the mute control can address it.
 */
import { useTranslation } from 'react-i18next'
import {
  VideoTrack,
  useConnectionState,
  useTracks,
  type TrackReference,
} from '@livekit/components-react'
import { ConnectionState, Track } from 'livekit-client'
import { Spinner as UiSpinner } from '@/ui'

function gridCols(count: number): string {
  if (count <= 1) return 'grid-cols-1'
  if (count <= 4) return 'grid-cols-1 sm:grid-cols-2'
  return 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3'
}

function trackKey(tr: TrackReference): string {
  return `${tr.participant.identity}:${tr.source}:${tr.publication?.trackSid ?? ''}`
}

function Tile({ trackRef }: { trackRef: TrackReference }) {
  const { t } = useTranslation('playerComponents')
  const isScreen = trackRef.source === Track.Source.ScreenShare
  const name =
    trackRef.participant.name || trackRef.participant.identity || t('video.participant')
  return (
    <div className="relative aspect-video overflow-hidden rounded-xl bg-black ring-1 ring-white/10">
      <VideoTrack
        trackRef={trackRef}
        className={`h-full w-full ${isScreen ? 'object-contain' : 'object-cover'}`}
      />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-2 bg-gradient-to-t from-black/70 to-transparent px-3 py-2">
        <span className="truncate text-xs font-medium text-white">{name}</span>
        {isScreen && (
          <span className="rounded bg-primary-500/25 px-1.5 py-0.5 text-[10px] font-semibold text-primary-100">
            {t('video.screen')}
          </span>
        )}
      </div>
    </div>
  )
}

function Spinner() {
  const { t } = useTranslation('playerComponents')
  return (
    <div className="flex flex-col items-center gap-3 text-gray-300">
      <UiSpinner size={32} />
      <span className="text-sm">{t('video.connectingRoom')}</span>
    </div>
  )
}

function EmptyRoom() {
  const { t } = useTranslation('playerComponents')
  return (
    <div className="flex max-w-sm flex-col items-center gap-3 px-6 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-white/10 ring-1 ring-white/15">
        <svg className="h-6 w-6 text-gray-400" fill="none" stroke="currentColor" strokeWidth={1.6} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.55-2.28A1 1 0 0121 8.6v6.8a1 1 0 01-1.45.89L15 14M4 6h9a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2V8a2 2 0 012-2z" />
        </svg>
      </div>
      <h3 className="text-sm font-medium text-white">{t('video.emptyTitle')}</h3>
      <p className="text-xs text-gray-400">{t('video.emptyBody')}</p>
    </div>
  )
}

export function VideoStage() {
  const state = useConnectionState()
  const tracks = useTracks([Track.Source.Camera, Track.Source.ScreenShare], {
    onlySubscribed: true,
  })

  const connecting =
    state === ConnectionState.Connecting || state === ConnectionState.Reconnecting

  return (
    <div className="flex h-full w-full items-center justify-center p-3">
      {tracks.length > 0 ? (
        <div className={`grid w-full gap-3 ${gridCols(tracks.length)}`}>
          {tracks.map((tr) => (
            <Tile key={trackKey(tr)} trackRef={tr} />
          ))}
        </div>
      ) : connecting ? (
        <Spinner />
      ) : (
        <EmptyRoom />
      )}
    </div>
  )
}
