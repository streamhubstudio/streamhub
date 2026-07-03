/**
 * Audio-only stage for the subscriber player (Wave 4 — voice channels & radio).
 * A compact bar that reflects whether anyone is publishing audio in the room,
 * with an "EN VIVO" indicator. Audio playback itself is handled by the parent
 * (<RoomAudioRenderer>), so the mute control still applies.
 *
 * Must live inside <LiveKitRoom>.
 */
import { useTranslation } from 'react-i18next'
import {
  useConnectionState,
  useTracks,
  type TrackReference,
} from '@livekit/components-react'
import { ConnectionState, Track } from 'livekit-client'

function Equalizer({ active }: { active: boolean }) {
  // Three pulsing bars when on air, flat when idle.
  return (
    <span className="flex h-6 items-end gap-1" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className={`w-1 rounded-full ${active ? 'animate-pulse bg-primary-400' : 'bg-white/20'}`}
          style={{
            height: active ? `${[10, 22, 14][i]}px` : '6px',
            animationDelay: `${i * 120}ms`,
          }}
        />
      ))}
    </span>
  )
}

export function AudioStage({ label }: { label?: string }) {
  const { t } = useTranslation('playerComponents')
  const displayLabel = label ?? t('audio.defaultLabel')
  const state = useConnectionState()
  const audioTracks = useTracks([Track.Source.Microphone], { onlySubscribed: true })
  const connecting =
    state === ConnectionState.Connecting || state === ConnectionState.Reconnecting
  const onAir = audioTracks.length > 0

  const speakers = audioTracks
    .map((t: TrackReference) => t.participant.name || t.participant.identity)
    .filter(Boolean)

  return (
    <div className="flex items-center gap-4 px-5 py-4">
      <Equalizer active={onAir} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {onAir ? (
            <span className="flex items-center gap-1.5 rounded-full bg-red-500/90 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />
              {t('audio.onAir')}
            </span>
          ) : connecting ? (
            <span className="rounded-full bg-amber-400 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-950">
              {t('audio.connecting')}
            </span>
          ) : (
            <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-gray-400">
              {t('audio.offline')}
            </span>
          )}
          <span className="truncate text-sm font-medium text-white">{displayLabel}</span>
        </div>
        <p className="mt-0.5 truncate text-[11px] text-gray-400">
          {onAir
            ? speakers.length > 0
              ? t('audio.speakers', { speakers: speakers.join(', ') })
              : t('audio.activeAudio')
            : connecting
              ? t('audio.connectingRoom')
              : t('audio.waiting')}
        </p>
      </div>
    </div>
  )
}
