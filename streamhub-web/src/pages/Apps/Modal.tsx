/**
 * Lightweight modal shell used by the Apps page (create / delete dialogs).
 * - Fixed overlay + centered Elstar-style card (solid surface, subtle border).
 * - Closes on backdrop click and Escape; locks body scroll while open.
 * Pure presentational: the parent owns open/close state.
 */
import { useEffect, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

interface ModalProps {
  title: string
  onClose: () => void
  children: ReactNode
  /** Optional footer (actions). Rendered right-aligned under the body. */
  footer?: ReactNode
}

export function Modal({ title, onClose, children, footer }: ModalProps) {
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
      className="fixed inset-0 z-50 flex items-end justify-center bg-gray-900/50 backdrop-blur-sm sm:items-center sm:p-4 dark:bg-black/60"
      onMouseDown={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        className="flex max-h-[92vh] w-full max-w-md flex-col rounded-t-2xl border border-gray-200 bg-white shadow-2xl sm:max-h-[90vh] sm:rounded-xl dark:border-gray-700 dark:bg-gray-800"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-gray-200 px-5 py-4 dark:border-gray-700">
          <h2 className="text-base font-semibold text-fg">{title}</h2>
          <button
            onClick={onClose}
            aria-label={t('actions.close')}
            className="rounded-md p-1 text-slate-400 transition hover:text-fg"
          >
            <svg
              className="h-5 w-5"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.8}
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M6 6l12 12M18 6L6 18"
              />
            </svg>
          </button>
        </div>

        <div className="overflow-y-auto px-5 py-5">{children}</div>

        {footer && (
          <div className="flex shrink-0 items-center justify-end gap-3 border-t border-gray-200 px-5 py-4 dark:border-gray-700">
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}
