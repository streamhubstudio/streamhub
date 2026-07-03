/**
 * Apps overview table — GET /apps (enveloped, camelCase fields). Each row
 * links to /apps/:name. Polls 30s (apps change far less often than stats).
 *
 * Re-skinned with the Elstar design system (Card + Table + Button + Alert).
 */
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { api, ApiRequestError, type App } from '@/api'
import { Alert, Button, Card, Table } from '@/ui'
import { formatDate } from './format'

const { THead, TBody, Tr, Th, Td } = Table

const POLL_MS = 30_000

export function AppsTable() {
  const { t } = useTranslation(['dashboard', 'common'])
  const { data, isLoading, isError, error, isFetching, refetch } = useQuery<App[]>({
    queryKey: ['apps'],
    queryFn: ({ signal }) => api.apps.list(signal),
    refetchInterval: POLL_MS,
  })

  const apps = data ?? []
  const errorMessage =
    error instanceof ApiRequestError
      ? error.message
      : t('dashboard:appsTable.loadError')

  return (
    <section>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-fg">
            {t('dashboard:appsTable.title')}
          </h2>
          <p className="text-xs text-slate-500">
            {t('dashboard:appsTable.subtitle')}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Link
            to="/apps"
            className="text-xs text-primary-500 transition hover:text-fg"
          >
            {t('dashboard:appsTable.viewAll')} →
          </Link>
          <Button size="xs" variant="default" onClick={() => refetch()}>
            {isFetching ? t('dashboard:updating') : t('common:actions.refresh')}
          </Button>
        </div>
      </div>

      {isError && !data && (
        <div className="mb-3">
          <Alert type="warning" showIcon>
            {errorMessage}
          </Alert>
        </div>
      )}

      <Card bordered bodyClass="p-0">
        {isLoading ? (
          <div className="px-5 py-10 text-center text-sm text-slate-500">
            {t('dashboard:appsTable.loading')}
          </div>
        ) : apps.length === 0 ? (
          <div className="px-5 py-10 text-center text-sm text-slate-500">
            {t('dashboard:appsTable.emptyBefore')}{' '}
            <Link to="/apps" className="text-primary-500 hover:text-fg">
              {t('dashboard:appsTable.emptyLink')}
            </Link>
            .
          </div>
        ) : (
          <Table>
            <THead>
              <Tr>
                <Th>{t('dashboard:appsTable.colName')}</Th>
                <Th>{t('dashboard:appsTable.colId')}</Th>
                <Th>{t('dashboard:appsTable.colRoomPrefix')}</Th>
                <Th>{t('dashboard:appsTable.colCreated')}</Th>
                <Th />
              </Tr>
            </THead>
            <TBody>
              {apps.map((app) => (
                <Tr key={app.id ?? app.name}>
                  <Td>
                    <Link
                      to={`/apps/${encodeURIComponent(app.name)}`}
                      className="font-medium text-fg hover:text-primary-500"
                    >
                      {app.displayName || app.name}
                    </Link>
                  </Td>
                  <Td className="font-mono text-xs text-slate-400">{app.name}</Td>
                  <Td className="font-mono text-xs text-slate-400">
                    {app.livekitRoomPrefix || '—'}
                  </Td>
                  <Td className="text-slate-400">{formatDate(app.createdAt)}</Td>
                  <Td className="text-right">
                    <Link
                      to={`/apps/${encodeURIComponent(app.name)}`}
                      className="text-xs text-primary-500 transition hover:text-fg"
                    >
                      {t('dashboard:appsTable.open')} →
                    </Link>
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </section>
  )
}
