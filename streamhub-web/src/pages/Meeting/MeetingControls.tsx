/**
 * Themed control bar for the meeting stage. Built from LiveKit primitives
 * (TrackToggle / DisconnectButton) instead of the prefab ControlBar so it
 * matches the navy/cyan StreamHub theme. Adds a reaction picker and a chat
 * toggle with an unread badge.
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Track } from 'livekit-client'
import { DisconnectButton, TrackToggle, useLocalParticipant } from '@livekit/components-react'
import { EMOJIS } from './dataChannel'

interface MeetingControlsProps {
  chatOpen: boolean
  unread: number
  onToggleChat: () => void
  onReact: (emoji: string) => void
  onDeviceError: (error: Error) => void
}

const btnBase =
  'flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition'

function toggleClass(active: boolean): string {
  return [
    btnBase,
    active
      ? 'bg-gray-800 text-fg ring-1 ring-gray-700'
      : 'bg-red-500/15 text-red-300 ring-1 ring-red-500/30',
  ].join(' ')
}

function Icon({ d }: { d: string }) {
  return (
    <svg
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      viewBox="0 0 24 24"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d={d} />
    </svg>
  )
}

export default function MeetingControls({
  chatOpen,
  unread,
  onToggleChat,
  onReact,
  onDeviceError,
}: MeetingControlsProps) {
  const { t } = useTranslation('meeting')
  const { isMicrophoneEnabled, isCameraEnabled, isScreenShareEnabled } =
    useLocalParticipant()
  const [showReactions, setShowReactions] = useState(false)

  return (
    <div className="relative flex flex-wrap items-center justify-center gap-2 border-t border-gray-800 bg-gray-900/80 px-4 py-3">
      <TrackToggle
        source={Track.Source.Microphone}
        showIcon={false}
        onDeviceError={onDeviceError}
        className={toggleClass(isMicrophoneEnabled)}
      >
        <Icon
          d={
            isMicrophoneEnabled
              ? 'M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3zM5 10v2a7 7 0 0014 0v-2M12 19v4'
              : 'M5 10v2a7 7 0 0010.5 6.06M9 9.3V4a3 3 0 016 0v6M3 3l18 18'
          }
        />
        {isMicrophoneEnabled ? t('controls.micOn') : t('controls.micOff')}
      </TrackToggle>

      <TrackToggle
        source={Track.Source.Camera}
        showIcon={false}
        onDeviceError={onDeviceError}
        className={toggleClass(isCameraEnabled)}
      >
        <Icon
          d={
            isCameraEnabled
              ? 'M15 10l4.5-2.5v9L15 14M3 7h12v10H3z'
              : 'M3 3l18 18M15 10l4.5-2.5v9M10 7h5v6'
          }
        />
        {isCameraEnabled ? t('controls.camOn') : t('controls.camOff')}
      </TrackToggle>

      <TrackToggle
        source={Track.Source.ScreenShare}
        showIcon={false}
        onDeviceError={onDeviceError}
        className={[
          btnBase,
          isScreenShareEnabled
            ? 'bg-primary-500/20 text-white ring-1 ring-primary-400/40'
            : 'bg-gray-800 text-gray-300 ring-1 ring-gray-700 hover:text-fg',
        ].join(' ')}
      >
        <Icon d="M4 5h16v10H4zM8 19h8M12 15v4" />
        <span className="hidden sm:inline">{t('controls.screen')}</span>
      </TrackToggle>

      {/* Reactions */}
      <div className="relative">
        <button
          onClick={() => setShowReactions((v) => !v)}
          className={[
            btnBase,
            'bg-gray-800 text-gray-300 ring-1 ring-gray-700 hover:text-fg',
          ].join(' ')}
        >
          <span className="text-base leading-none">🎉</span>
          <span className="hidden sm:inline">{t('controls.reaction')}</span>
        </button>
        {showReactions && (
          <div className="absolute bg-gray-900/90 ring-1 ring-white/10 backdrop-blur bottom-full left-1/2 mb-2 flex -translate-x-1/2 gap-1 rounded-xl px-2 py-1.5 shadow-xl">
            {EMOJIS.map((e) => (
              <button
                key={e}
                onClick={() => {
                  onReact(e)
                  setShowReactions(false)
                }}
                className="rounded-md px-1.5 py-1 text-xl transition hover:scale-125 hover:bg-gray-800"
              >
                {e}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Chat */}
      <button
        onClick={onToggleChat}
        className={[
          btnBase,
          'relative',
          chatOpen
            ? 'bg-primary-500/20 text-white ring-1 ring-primary-400/40'
            : 'bg-gray-800 text-gray-300 ring-1 ring-gray-700 hover:text-fg',
        ].join(' ')}
      >
        <Icon d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
        <span className="hidden sm:inline">{t('controls.chat')}</span>
        {unread > 0 && !chatOpen && (
          <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-primary-500 px-1 text-[10px] font-bold text-white">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      <DisconnectButton
        className={[btnBase, 'bg-red-500/90 text-white hover:bg-red-500'].join(' ')}
      >
        <Icon d="M17 16l4-4m0 0l-4-4m4 4H7M13 16v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
        {t('controls.leave')}
      </DisconnectButton>
    </div>
  )
}
