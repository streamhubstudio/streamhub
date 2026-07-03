/**
 * Subscriber player chrome: connection pill + mute toggle + fullscreen toggle.
 * Presentational; the parent owns the muted state (so it can pass it to
 * <RoomAudioRenderer muted>) and the fullscreen target ref.
 */
import { useTranslation } from 'react-i18next'
import { ConnectionPill } from './ConnectionPill'

interface PlayerControlsProps {
  muted: boolean
  onToggleMute: () => void
  isFullscreen: boolean
  onToggleFullscreen: () => void
  className?: string
}

function Icon({ d }: { d: string }) {
  return (
    <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d={d} />
    </svg>
  )
}

const iconBtn =
  'flex h-10 w-10 items-center justify-center rounded-lg bg-black/60 text-white/90 ring-1 ring-white/15 backdrop-blur transition hover:bg-black/70 hover:text-white hover:ring-primary-400/50'

export function PlayerControls({
  muted,
  onToggleMute,
  isFullscreen,
  onToggleFullscreen,
  className = '',
}: PlayerControlsProps) {
  const { t } = useTranslation('playerComponents')
  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <ConnectionPill />
      <button
        onClick={onToggleMute}
        aria-label={muted ? t('controls.unmute') : t('controls.mute')}
        className={iconBtn}
      >
        <Icon
          d={
            muted
              ? 'M11 5L6 9H2v6h4l5 4V5zM23 9l-6 6M17 9l6 6'
              : 'M11 5L6 9H2v6h4l5 4V5zM15.5 8.5a5 5 0 010 7M18.5 5.5a9 9 0 010 13'
          }
        />
      </button>
      <button
        onClick={onToggleFullscreen}
        aria-label={isFullscreen ? t('controls.exitFullscreen') : t('controls.enterFullscreen')}
        className={iconBtn}
      >
        <Icon
          d={
            isFullscreen
              ? 'M9 9H5m0 0V5m0 4l5-5M15 9h4m0 0V5m0 4l-5-5M9 15H5m0 0v4m0-4l5 5M15 15h4m0 0v4m0-4l-5 5'
              : 'M4 9V5a1 1 0 011-1h4M20 9V5a1 1 0 00-1-1h-4M4 15v4a1 1 0 001 1h4M20 15v4a1 1 0 01-1 1h-4'
          }
        />
      </button>
    </div>
  )
}
