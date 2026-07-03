/**
 * Modal shell for the Marketplace (configure / logs dialogs). Mirrors the Apps
 * modal (fixed overlay + centered glass card, Esc + backdrop close, scroll
 * lock) but is scoped to this page.
 */
import { useEffect, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

export function Modal({
  title,
  subtitle,
  onClose,
  children,
  wide,
}: {
  title: string
  subtitle?: string
  onClose: () => void
  children: ReactNode
  /** Use a wider card (e.g. logs). */
  wide?: boolean
}) {
  const { t } = useTranslation('common')
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-navy-900/70 backdrop-blur-sm sm:items-center sm:p-4"
      onMouseDown={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        className={[
          'glass flex max-h-[92vh] w-full flex-col rounded-t-2xl shadow-2xl sm:max-h-[90vh] sm:rounded-xl',
          wide ? 'max-w-2xl' : 'max-w-lg',
        ].join(' ')}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-navy-600 px-5 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold text-fg">{title}</h2>
            {subtitle && <p className="mt-0.5 text-xs text-slate-400">{subtitle}</p>}
          </div>
          <button
            onClick={onClose}
            aria-label={t('actions.close')}
            className="shrink-0 rounded-md p-1 text-slate-400 transition hover:text-fg"
          >
            <svg
              className="h-5 w-5"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.8}
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
        <div className="overflow-y-auto px-5 py-5">{children}</div>
      </div>
    </div>
  )
}
