/**
 * Live viewer counter. Counts the participants currently in the room (LiveKit
 * excludes `hidden` QC/recorder grants automatically, so they are never counted
 * as viewers). Must be rendered inside <LiveKitRoom>.
 */
import { useTranslation } from 'react-i18next'
import { useParticipants } from '@livekit/components-react'

export function ViewerBadge({ className = '' }: { className?: string }) {
  const { t } = useTranslation('playerComponents')
  const participants = useParticipants()
  const count = participants.length

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full bg-black/60 px-3 py-1 text-xs font-medium text-white/90 ring-1 ring-white/15 backdrop-blur ${className}`}
    >
      <svg className="h-3.5 w-3.5 text-primary-400" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12s-3.5 6.5-9.5 6.5S2.5 12 2.5 12z" />
        <circle cx="12" cy="12" r="2.6" />
      </svg>
      {t('viewers.count', { count })}
    </span>
  )
}
