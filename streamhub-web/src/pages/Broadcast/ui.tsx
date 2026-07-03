/**
 * Presentational helpers for the Broadcast (Studio) page — re-skinned to the
 * Elstar design system (`@/ui`) on the StreamHub brand token (`primary`). Pure
 * UI, light/dark via `.dark`. No business logic lives here.
 *
 * Shared by the Broadcast/Radio pages and the streaming/radio plugins, so a
 * single re-skin here flows through all of them. Inputs stay native (adopting
 * the Elstar `.input` look) and banners render the Elstar <Alert>.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert } from '@/ui'
import type { Phase } from './usePublisher'

/** Live, self-ticking mm:ss (or h:mm:ss) duration since an epoch-ms timestamp. */
export function Duration({ since }: { since: number }) {
  const [, force] = useState(0)
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [])
  const secs = Math.max(0, Math.floor((Date.now() - since) / 1000))
  const h = Math.floor(secs / 3600)
  const m = String(Math.floor((secs % 3600) / 60)).padStart(2, '0')
  const s = String(secs % 60).padStart(2, '0')
  return (
    <span className="font-mono tabular-nums">
      {h > 0 ? `${h}:` : ''}
      {m}:{s}
    </span>
  )
}

/** Big LIVE / state pill shown over the preview. */
export function PhaseBadge({ phase }: { phase: Phase }) {
  const { t } = useTranslation('broadcast')
  if (phase === 'live') {
    return (
      <span className="flex items-center gap-1.5 rounded-full bg-red-500 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-white shadow">
        <span className="h-2 w-2 animate-pulse rounded-full bg-white" />
        {t('phase.live')}
      </span>
    )
  }
  if (phase === 'connecting') {
    return (
      <span className="flex items-center gap-1.5 rounded-full bg-amber-400 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-amber-950">
        <span className="h-2 w-2 animate-ping rounded-full bg-amber-950/70" />
        {t('phase.connecting')}
      </span>
    )
  }
  if (phase === 'stopping') {
    return (
      <span className="rounded-full bg-gray-200 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-gray-600 dark:bg-gray-700 dark:text-gray-200">
        {t('phase.stopping')}
      </span>
    )
  }
  return (
    <span className="rounded-full bg-gray-100 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:bg-gray-700/70 dark:text-gray-400">
      {t('phase.idle')}
    </span>
  )
}

/** Small status chip for the egress status string. */
export function EgressStatus({ status }: { status: string }) {
  const ok = /ACTIVE|STARTING|EGRESS_ACTIVE/i.test(status)
  const bad = /FAILED|ABORTED/i.test(status)
  const tone = bad
    ? 'bg-red-100 text-red-600 dark:bg-red-500/20 dark:text-red-200'
    : ok
      ? 'bg-emerald-100 text-emerald-600 dark:bg-emerald-500/20 dark:text-emerald-200'
      : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 font-mono text-[11px] font-semibold ${tone}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current opacity-80" />
      {status || '—'}
    </span>
  )
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: ReactNode
  children: ReactNode
}) {
  return (
    <label className="block">
      <span className="block text-sm font-semibold text-gray-700 dark:text-gray-100">
        {label}
      </span>
      <div className="mt-1.5">{children}</div>
      {hint && (
        <p className="mt-1 text-xs leading-snug text-gray-500 dark:text-gray-400">{hint}</p>
      )}
    </label>
  )
}

// Elstar `.input` look, brand-focused + a solid surface so it reads on cards.
const fieldClass =
  'input text-sm bg-white dark:bg-gray-700 focus:ring-primary-500 focus:border-primary-500 disabled:cursor-not-allowed disabled:opacity-50'

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={fieldClass} />
}

export function DeviceSelect({
  devices,
  value,
  onChange,
  disabled,
  emptyLabel,
}: {
  devices: MediaDeviceInfo[]
  value: string
  onChange: (id: string) => void
  disabled?: boolean
  emptyLabel: string
}) {
  const { t } = useTranslation('broadcast')
  return (
    <select
      value={value}
      disabled={disabled || devices.length === 0}
      onChange={(e) => onChange(e.target.value)}
      className={fieldClass}
    >
      {devices.length === 0 ? (
        <option value="">{emptyLabel}</option>
      ) : (
        devices.map((d, i) => (
          <option key={d.deviceId || i} value={d.deviceId}>
            {d.label || t('device', { n: i + 1 })}
          </option>
        ))
      )}
    </select>
  )
}

export function Banner({
  tone,
  children,
  onClose,
}: {
  tone: 'error' | 'warning'
  children: ReactNode
  onClose?: () => void
}) {
  return (
    <Alert
      type={tone === 'error' ? 'danger' : 'warning'}
      showIcon
      rounded
      closable={Boolean(onClose)}
      onClose={onClose}
    >
      {children}
    </Alert>
  )
}
