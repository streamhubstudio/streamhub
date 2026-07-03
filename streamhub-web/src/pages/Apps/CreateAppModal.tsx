/**
 * Create-app modal. POST /apps { name, displayName?, roomPrefix? } via
 * api.apps.create, then invalidates the ['apps'] query so the list refreshes.
 *
 * `name` is a required slug (unique). `displayName` / `roomPrefix` are optional;
 * empty strings are dropped so the server can derive its defaults.
 */
import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api, ApiRequestError, type App, type CreateAppRequest } from '@/api'
import { Alert, Button, Input } from '@/ui'
import { Modal } from './Modal'

interface CreateAppModalProps {
  onClose: () => void
  onCreated: (app: App) => void
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/

export function CreateAppModal({ onClose, onCreated }: CreateAppModalProps) {
  const { t } = useTranslation(['apps', 'common'])
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [roomPrefix, setRoomPrefix] = useState('')
  const [validationError, setValidationError] = useState<string | null>(null)

  const mutation = useMutation({
    mutationFn: (payload: CreateAppRequest) => api.apps.create(payload),
    onSuccess: (app) => {
      queryClient.invalidateQueries({ queryKey: ['apps'] })
      onCreated(app)
    },
  })

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) {
      setValidationError(t('apps:create.errorNameRequired'))
      return
    }
    if (!SLUG_RE.test(trimmed)) {
      setValidationError(t('apps:create.errorNameSlug'))
      return
    }
    setValidationError(null)

    const payload: CreateAppRequest = { name: trimmed }
    const dn = displayName.trim()
    const rp = roomPrefix.trim()
    if (dn) payload.displayName = dn
    if (rp) payload.roomPrefix = rp
    mutation.mutate(payload)
  }

  const apiError =
    mutation.error instanceof ApiRequestError
      ? mutation.error.message
      : mutation.isError
        ? t('apps:create.errorCreate')
        : null
  const error = validationError ?? apiError

  return (
    <Modal
      title={t('apps:create.title')}
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
            form="create-app-form"
            loading={mutation.isPending}
          >
            {mutation.isPending ? t('apps:create.submitting') : t('apps:create.submit')}
          </Button>
        </>
      }
    >
      <form id="create-app-form" onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-400">
            {t('apps:create.nameLabel')} <span className="text-red-400">*</span>
          </label>
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="live"
            spellCheck={false}
            autoComplete="off"
          />
          <p className="mt-1 text-xs text-slate-500">{t('apps:create.nameHint')}</p>
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-slate-400">
            {t('apps:create.displayNameLabel')}
          </label>
          <Input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Live"
            autoComplete="off"
          />
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-slate-400">
            {t('apps:create.roomPrefixLabel')}
          </label>
          <Input
            value={roomPrefix}
            onChange={(e) => setRoomPrefix(e.target.value)}
            placeholder={t('apps:create.roomPrefixPlaceholder')}
            spellCheck={false}
            autoComplete="off"
          />
        </div>

        {error && (
          <Alert type="danger" showIcon>
            {error}
          </Alert>
        )}
      </form>
    </Modal>
  )
}
