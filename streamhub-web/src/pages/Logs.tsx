/**
 * Logs — global server feed (GET /logs).
 *
 * Reference page for the intended pattern:
 *  - data via @tanstack/react-query + the typed `api` client
 *  - explicit loading / error / empty states
 *  - debounced + live filters (app, level, source, free-text q) driving the key
 *  - real pagination via the shared <Pagination>, sized off the envelope total
 *
 * Re-skinned with the Elstar design system (Card + Input + Button + Alert).
 */
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { api, ApiRequestError, type LogEntry, type LogLevel } from '@/api'
import { Alert, Button, Card, Input, Pagination } from '@/ui'

const LEVELS: LogLevel[] = ['info', 'warn', 'error']
const PAGE_SIZE = 100

/** Small debounce so typing in the text filters doesn't spam the API. */
function useDebounced<T>(value: T, ms = 400): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms)
    return () => clearTimeout(id)
  }, [value, ms])
  return debounced
}

function levelClass(level: string): string {
  const l = level.toLowerCase()
  if (l === 'error' || l === 'fatal') return 'text-red-400'
  if (l === 'warn') return 'text-amber-400'
  return 'text-primary-500'
}

function field(entry: LogEntry, ...keys: (keyof LogEntry)[]): string {
  for (const k of keys) {
    const v = entry[k]
    if (v !== undefined && v !== null && v !== '') return String(v)
  }
  return ''
}

const selectClass =
  'input input-md h-11 max-md:w-full ltr:pr-8 rtl:pl-8 bg-white focus:border-primary-500 focus:ring-primary-500 dark:bg-gray-700'

export default function Logs() {
  const { t } = useTranslation(['logs', 'common'])
  const [app, setApp] = useState('')
  const [level, setLevel] = useState<LogLevel | ''>('')
  const [source, setSource] = useState('')
  const [q, setQ] = useState('')
  const [page, setPage] = useState(1)

  const debouncedApp = useDebounced(app)
  const debouncedSource = useDebounced(source)
  const debouncedQ = useDebounced(q)

  useEffect(() => {
    setPage(1)
  }, [debouncedApp, level, debouncedSource, debouncedQ])

  const params = useMemo(
    () => ({
      app: debouncedApp || undefined,
      level: level || undefined,
      source: debouncedSource || undefined,
      q: debouncedQ || undefined,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    }),
    [debouncedApp, level, debouncedSource, debouncedQ, page],
  )

  const { data, isLoading, isError, error, isFetching, refetch } = useQuery({
    queryKey: ['logs', params],
    queryFn: ({ signal }) => api.logs.query(params, signal),
    refetchInterval: 10_000,
    placeholderData: keepPreviousData,
  })

  const logs = data?.items ?? []
  const effectiveTotal =
    data?.total ??
    (logs.length < PAGE_SIZE
      ? (page - 1) * PAGE_SIZE + logs.length
      : page * PAGE_SIZE + 1)
  const errorMessage =
    error instanceof ApiRequestError ? error.message : t('logs:loadError')

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-fg">{t('logs:title')}</h1>
          <p className="text-sm text-slate-400">{t('logs:subtitle')}</p>
        </div>
      </div>

      {/* Filters */}
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <select
          value={level}
          onChange={(e) => setLevel(e.target.value as LogLevel | '')}
          className={selectClass}
        >
          <option value="">{t('logs:allLevels')}</option>
          {LEVELS.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
        <div className="max-md:w-full">
          <Input
            value={app}
            onChange={(e) => setApp(e.target.value)}
            placeholder={t('logs:filterApp')}
          />
        </div>
        <div className="max-md:w-full">
          <Input
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder={t('logs:filterSource')}
          />
        </div>
        <div className="max-md:w-full md:flex-1 md:min-w-[12rem]">
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('logs:filterSearch')}
          />
        </div>
        <Button
          size="sm"
          variant="default"
          onClick={() => refetch()}
          className="max-md:w-full"
        >
          {isFetching ? t('logs:updating') : t('common:actions.refresh')}
        </Button>
      </div>

      {isError && (
        <div className="mb-5">
          <Alert type="warning" showIcon>
            {errorMessage}
          </Alert>
        </div>
      )}

      <Card bordered bodyClass="p-0" className="overflow-hidden font-mono text-xs">
        {isLoading ? (
          <div className="px-5 py-10 text-center font-sans text-slate-500">
            {t('logs:loading')}
          </div>
        ) : logs.length === 0 ? (
          <div className="px-5 py-10 text-center font-sans text-slate-500">
            {t('logs:empty')}
          </div>
        ) : (
          <div className="max-h-[70vh] divide-y divide-gray-200 overflow-auto dark:divide-gray-700">
            {logs.map((entry, i) => {
              const lvl = field(entry, 'level') || 'info'
              return (
                <div
                  key={i}
                  className="px-4 py-2 hover:bg-gray-100/50 md:flex md:gap-3 md:py-1.5 dark:hover:bg-gray-700/40"
                >
                  {/* Meta wraps inline on mobile; becomes fixed columns from md up. */}
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 md:contents">
                    <span className="text-slate-500 md:w-44 md:shrink-0">
                      {field(entry, 'ts', 'time')}
                    </span>
                    <span className={`shrink-0 md:w-12 ${levelClass(lvl)}`}>
                      {lvl.toUpperCase()}
                    </span>
                    <span className="text-slate-500 md:w-24 md:shrink-0">
                      {field(entry, 'source', 'app')}
                    </span>
                  </div>
                  <span className="mt-1 block break-all text-slate-300 md:mt-0">
                    {field(entry, 'message', 'msg')}
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </Card>

      {effectiveTotal > PAGE_SIZE && (
        <div className="mt-4 flex justify-end">
          <Pagination
            currentPage={page}
            pageSize={PAGE_SIZE}
            total={effectiveTotal}
            onChange={setPage}
          />
        </div>
      )}
    </div>
  )
}
