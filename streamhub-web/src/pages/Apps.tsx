/**
 * Apps — tenant management.
 *
 * Lists apps (GET /apps), creates them (POST /apps) via a modal, and deletes
 * them (DELETE /apps/:name) behind a typed confirmation. Each card links to the
 * detail route /apps/:name. Follows the data/loading/error pattern from Logs.
 *
 * Re-skinned with the Elstar design system (Card + Button + Alert).
 */
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { api, ApiRequestError, type App } from '@/api'
import { Alert, Button, Card } from '@/ui'
import { useAuth } from '@/auth/useAuth'
import { CreateAppModal } from './Apps/CreateAppModal'
import { DeleteAppDialog } from './Apps/DeleteAppDialog'

function formatDate(value?: string): string {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

function AppCard({
  app,
  onDelete,
  canEdit,
}: {
  app: App
  onDelete: (app: App) => void
  canEdit: boolean
}) {
  const { t } = useTranslation('apps')
  // De-dup: the title already shows the human name (falling back to the slug).
  // Only show the slug line when a distinct display name exists, and only show
  // the room-prefix row when it isn't just the slug repeated.
  const displayName = app.displayName?.trim()
  const showSlug = Boolean(displayName && displayName !== app.name)
  const showPrefix = Boolean(app.livekitRoomPrefix && app.livekitRoomPrefix !== app.name)
  return (
    <Card
      bordered
      className="group relative transition hover:ring-1 hover:ring-primary-500/40"
      bodyClass="flex flex-col p-5"
    >
      {canEdit && (
        <button
          onClick={() => onDelete(app)}
          aria-label={t('card.deleteAria', { name: app.name })}
          title={t('card.deleteTitle')}
          className="absolute right-3 top-3 rounded-md p-1.5 text-slate-500 opacity-0 transition hover:bg-red-500/10 hover:text-red-400 focus:opacity-100 group-hover:opacity-100"
        >
          <svg
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.8}
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M6 7h12M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2m-7 0v12a1 1 0 001 1h6a1 1 0 001-1V7"
            />
          </svg>
        </button>
      )}

      <Link to={`/apps/${encodeURIComponent(app.name)}`} className="block pr-7">
        <h3 className="truncate text-base font-semibold text-fg">
          {app.displayName || app.name}
        </h3>
        {showSlug && (
          <p className="mt-0.5 truncate font-mono text-xs text-primary-500">{app.name}</p>
        )}
      </Link>

      <dl className="mt-4 space-y-1.5 text-xs">
        {showPrefix && (
          <div className="flex justify-between gap-3">
            <dt className="text-slate-500">{t('card.roomPrefix')}</dt>
            <dd className="truncate font-mono text-slate-300">
              {app.livekitRoomPrefix}
            </dd>
          </div>
        )}
        <div className="flex justify-between gap-3">
          <dt className="text-slate-500">{t('card.created')}</dt>
          <dd className="text-slate-300">{formatDate(app.createdAt)}</dd>
        </div>
      </dl>

      <Link
        to={`/apps/${encodeURIComponent(app.name)}`}
        className="mt-4 inline-flex items-center gap-1 text-xs font-medium text-primary-500 transition hover:text-primary-400"
      >
        {t('card.detail')}
        <svg
          className="h-3.5 w-3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
      </Link>
    </Card>
  )
}

export default function Apps() {
  const { t } = useTranslation(['apps', 'common'])
  const { canEdit } = useAuth()
  const [showCreate, setShowCreate] = useState(false)
  const [toDelete, setToDelete] = useState<App | null>(null)

  const { data, isLoading, isError, error, isFetching, refetch } = useQuery({
    queryKey: ['apps'],
    queryFn: ({ signal }) => api.apps.list(signal),
  })

  const apps = data ?? []
  const errorMessage =
    error instanceof ApiRequestError ? error.message : t('apps:page.loadError')

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-fg">{t('apps:page.title')}</h1>
          <p className="text-sm text-slate-400">{t('apps:page.subtitle')}</p>
        </div>
        <div className="flex items-center gap-3 max-md:w-full">
          <Button size="sm" variant="default" onClick={() => refetch()}>
            {isFetching ? t('apps:page.updating') : t('common:actions.refresh')}
          </Button>
          {canEdit && (
            <Button size="sm" variant="solid" onClick={() => setShowCreate(true)}>
              {t('apps:page.new')}
            </Button>
          )}
        </div>
      </div>

      {isError && (
        <div className="mb-5">
          <Alert type="warning" showIcon>
            {errorMessage}
          </Alert>
        </div>
      )}

      {isLoading ? (
        <Card bordered bodyClass="px-5 py-16 text-center text-sm text-slate-500">
          {t('apps:page.loading')}
        </Card>
      ) : apps.length === 0 ? (
        isError ? (
          <Card bordered bodyClass="px-5 py-16 text-center">
            <p className="text-sm text-slate-400">{t('apps:page.emptyNoData')}</p>
          </Card>
        ) : (
          // First-run onboarding: a brand-new tenant has no apps yet (the apps
          // list is tenant-scoped) — guide them to create their first one.
          <Card bordered bodyClass="px-5 py-12 text-center">
            <h2 className="text-lg font-semibold text-fg">
              {t('apps:page.onboardTitle')}
            </h2>
            <p className="mx-auto mt-2 max-w-md text-sm text-slate-400">
              {t('apps:page.onboardBody')}
            </p>
            <ol className="mx-auto mt-5 flex max-w-sm flex-col gap-2 text-left text-sm text-slate-300">
              <li className="flex gap-2">
                <span className="text-primary-400">1.</span>
                {t('apps:page.onboardStep1')}
              </li>
              <li className="flex gap-2">
                <span className="text-primary-400">2.</span>
                {t('apps:page.onboardStep2')}
              </li>
              <li className="flex gap-2">
                <span className="text-primary-400">3.</span>
                {t('apps:page.onboardStep3')}
              </li>
            </ol>
            {canEdit && (
              <div className="mt-6 flex justify-center">
                <Button variant="solid" onClick={() => setShowCreate(true)}>
                  {t('apps:page.createFirst')}
                </Button>
              </div>
            )}
          </Card>
        )
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {apps.map((app) => (
            <AppCard
              key={app.id ?? app.name}
              app={app}
              onDelete={setToDelete}
              canEdit={canEdit}
            />
          ))}
        </div>
      )}

      {showCreate && (
        <CreateAppModal
          onClose={() => setShowCreate(false)}
          onCreated={() => setShowCreate(false)}
        />
      )}

      {toDelete && (
        <DeleteAppDialog
          app={toDelete}
          onClose={() => setToDelete(null)}
          onDeleted={() => setToDelete(null)}
        />
      )}
    </div>
  )
}
