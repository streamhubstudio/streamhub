/**
 * Strong confirmation for POST /admin/restart (restarts the whole
 * streamhub-core process). This is intentionally high-friction: restarting the
 * process interrupts the live streams of EVERY app on the server, not just this
 * one. The user must tick an acknowledgement before the destructive button
 * enables.
 *
 * RE-SKIN: rendered inside the Elstar `<Dialog>` (react-modal based — handles
 * the overlay, Escape and body-scroll lock). Confirm logic is unchanged.
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog, Button } from '@/ui'

export function RestartServerDialog({
  onConfirm,
  onClose,
  pending,
  error,
}: {
  onConfirm: () => void
  onClose: () => void
  pending: boolean
  /** Optional server-side error message from a failed restart attempt. */
  error?: string | null
}) {
  const { t } = useTranslation(['configTab', 'common'])
  const [ack, setAck] = useState(false)

  const requestClose = () => {
    if (!pending) onClose()
  }

  return (
    <Dialog
      isOpen
      width={480}
      closable={!pending}
      onClose={requestClose}
      onRequestClose={requestClose}
      aria-label={t('restartDialog.title')}
    >
      <div className="flex items-center gap-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-red-100 text-red-600 dark:bg-red-500/20 dark:text-red-100">
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
              d="M12 9v4m0 4h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"
            />
          </svg>
        </span>
        <h5 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          {t('restartDialog.title')}
        </h5>
      </div>

      <div className="mt-5 space-y-4">
        <p className="text-sm text-gray-600 dark:text-gray-300">
          {t('restartDialog.body')}
        </p>

        <div className="rounded-lg bg-red-50 px-4 py-3 text-xs font-medium text-red-700 dark:bg-red-500/15 dark:text-red-100">
          {t('restartDialog.warning')}
        </div>

        <label className="flex items-start gap-2 text-sm text-gray-600 dark:text-gray-300">
          <input
            type="checkbox"
            checked={ack}
            disabled={pending}
            onChange={(e) => setAck(e.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 rounded border-gray-300 accent-red-500 dark:border-gray-600"
          />
          {t('restartDialog.ack')}
        </label>

        {error && (
          <div className="rounded-lg bg-red-50 px-3 py-2 text-xs font-medium text-red-700 dark:bg-red-500/15 dark:text-red-100">
            {error}
          </div>
        )}
      </div>

      <div className="mt-6 flex items-center justify-end gap-2">
        <Button size="sm" disabled={pending} onClick={onClose}>
          {t('common:actions.cancel')}
        </Button>
        <Button
          size="sm"
          variant="solid"
          color="red-600"
          disabled={!ack || pending}
          loading={pending}
          onClick={onConfirm}
        >
          {pending ? t('restartDialog.restarting') : t('restartDialog.confirm')}
        </Button>
      </div>
    </Dialog>
  )
}
