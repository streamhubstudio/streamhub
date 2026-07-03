/**
 * Destructive confirmation for DELETE /apps/:name.
 * Requires typing the app name to confirm. Optional `deleteVods` checkbox maps
 * to the `?deleteVods=` query param (purges VODs / local files). Invalidates
 * the ['apps'] query on success.
 */
import { useState, type FormEvent } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api, ApiRequestError, type App } from '@/api'
import { Alert, Button, Input } from '@/ui'
import { Modal } from './Modal'

interface DeleteAppDialogProps {
  app: App
  onClose: () => void
  onDeleted: () => void
}

export function DeleteAppDialog({ app, onClose, onDeleted }: DeleteAppDialogProps) {
  const { t } = useTranslation(['apps', 'common'])
  const queryClient = useQueryClient()
  const [confirmText, setConfirmText] = useState('')
  const [deleteVods, setDeleteVods] = useState(false)

  const mutation = useMutation({
    mutationFn: () => api.apps.remove(app.name, deleteVods),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['apps'] })
      onDeleted()
    },
  })

  const confirmed = confirmText.trim() === app.name

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!confirmed || mutation.isPending) return
    mutation.mutate()
  }

  const apiError =
    mutation.error instanceof ApiRequestError
      ? mutation.error.message
      : mutation.isError
        ? t('apps:delete.error')
        : null

  return (
    <Modal
      title={t('apps:delete.title')}
      onClose={onClose}
      footer={
        <>
          <Button
            type="button"
            size="sm"
            variant="default"
            onClick={onClose}
            disabled={mutation.isPending}
          >
            {t('common:actions.cancel')}
          </Button>
          <Button
            type="submit"
            size="sm"
            variant="solid"
            color="red-600"
            form="delete-app-form"
            disabled={!confirmed}
            loading={mutation.isPending}
          >
            {mutation.isPending ? t('apps:delete.submitting') : t('apps:delete.submit')}
          </Button>
        </>
      }
    >
      <form id="delete-app-form" onSubmit={handleSubmit} className="space-y-4">
        <p className="text-sm text-slate-300">
          <Trans
            i18nKey="apps:delete.warning"
            values={{ name: app.displayName || app.name }}
            components={{ strong: <span className="font-semibold text-fg" /> }}
          />
        </p>

        <div>
          <label className="mb-1 block text-xs font-medium text-slate-400">
            <Trans
              i18nKey="apps:delete.confirmLabel"
              values={{ name: app.name }}
              components={{ code: <span className="font-mono text-slate-200" /> }}
            />
          </label>
          <Input
            autoFocus
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            spellCheck={false}
            autoComplete="off"
          />
        </div>

        <label className="flex items-center gap-2 text-sm text-slate-300">
          <input
            type="checkbox"
            checked={deleteVods}
            onChange={(e) => setDeleteVods(e.target.checked)}
            className="h-4 w-4 rounded border-gray-300 accent-red-500 dark:border-gray-600"
          />
          {t('apps:delete.deleteVods')}
        </label>

        {apiError && (
          <Alert type="danger" showIcon>
            {apiError}
          </Alert>
        )}
      </form>
    </Modal>
  )
}
