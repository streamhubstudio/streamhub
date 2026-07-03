/**
 * Live connection-state badge: conectando / reconectando / EN VIVO /
 * desconectado. Reads the LiveKit room context (must be inside <LiveKitRoom>),
 * so the operator can tell a broken signal from an idle room.
 */
import { useTranslation } from 'react-i18next'
import { useConnectionState } from '@livekit/components-react'
import { ConnectionState } from 'livekit-client'

interface Descriptor {
  labelKey: string
  dot: string
  text: string
  ring: string
  pulse: boolean
}

function describe(state: ConnectionState): Descriptor {
  switch (state) {
    case ConnectionState.Connected:
      return { labelKey: 'common:state.live', dot: 'bg-success', text: 'text-success', ring: 'ring-success/30', pulse: true }
    case ConnectionState.Connecting:
      return { labelKey: 'connection.connecting', dot: 'bg-primary-400', text: 'text-primary-300', ring: 'ring-primary-400/30', pulse: true }
    case ConnectionState.Reconnecting:
    case ConnectionState.SignalReconnecting:
      return { labelKey: 'connection.reconnecting', dot: 'bg-amber-400', text: 'text-amber-300', ring: 'ring-amber-400/30', pulse: true }
    case ConnectionState.Disconnected:
    default:
      return { labelKey: 'connection.disconnected', dot: 'bg-gray-400', text: 'text-gray-300', ring: 'ring-gray-400/30', pulse: false }
  }
}

export function ConnectionPill({ className = '' }: { className?: string }) {
  const { t } = useTranslation('playerComponents')
  const state = useConnectionState()
  const d = describe(state)
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full bg-black/60 px-3 py-1 text-xs font-semibold ring-1 backdrop-blur ${d.ring} ${d.text} ${className}`}
    >
      <span className={`h-2 w-2 rounded-full ${d.dot} ${d.pulse ? 'animate-pulse' : ''}`} />
      {t(d.labelKey)}
    </span>
  )
}
