/**
 * Logs tab — GET /apps/:app/logs, scoped to this app by path. Supports the new
 * level / source / free-text (q) filters plus real pagination (pageSize 50)
 * driven by the envelope's `total`. Same look as the global Logs page.
 */
import { useEffect, useMemo, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '@/api'
import type { LogEntry, LogLevel } from '@/api'
import { Pagination } from '@/ui'
import {
  Button,
  Card,
  Empty,
  ErrorBanner,
  Loading,
  SectionTitle,
  Select,
  TextInput,
  errMessage,
} from './ui'

const LEVELS: LogLevel[] = ['info', 'warn', 'error']
const PAGE_SIZE = 50

function levelClass(level: string): string {
  const l = level.toLowerCase()
  if (l === 'error' || l === 'fatal') return 'text-danger'
  if (l === 'warn') return 'text-warn'
  return 'text-info'
}

function field(entry: LogEntry, ...keys: (keyof LogEntry)[]): string {
  for (const k of keys) {
    const v = entry[k]
    if (v !== undefined && v !== null && v !== '') return String(v)
  }
  return ''
}

/** Small debounce so typing in the source / search fields doesn't spam the API. */
function useDebounced<T>(value: T, ms = 400): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms)
    return () => clearTimeout(id)
  }, [value, ms])
  return debounced
}

export function LogsTab({ app }: { app: string }) {
  const { t } = useTranslation(['logsTab', 'common', 'appDetail'])
  const [level, setLevel] = useState<LogLevel | ''>('')
  const [source, setSource] = useState('')
  const [q, setQ] = useState('')
  const [page, setPage] = useState(1)

  const debouncedSource = useDebounced(source)
  const debouncedQ = useDebounced(q)

  useEffect(() => {
    setPage(1)
  }, [level, debouncedSource, debouncedQ])

  const params = useMemo(
    () => ({
      level: level || undefined,
      source: debouncedSource || undefined,
      q: debouncedQ || undefined,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    }),
    [level, debouncedSource, debouncedQ, page],
  )

  const { data, isLoading, isError, error, isFetching, refetch } = useQuery({
    queryKey: ['app-logs', app, params],
    queryFn: ({ signal }) => api.logs.queryApp(app, params, signal),
    refetchInterval: 10_000,
    placeholderData: keepPreviousData,
  })

  const logs = data?.items ?? []
  // When the backend omits `total`, still allow paging forward while a full
  // page comes back (there might be more).
  const effectiveTotal =
    data?.total ??
    (logs.length < PAGE_SIZE
      ? (page - 1) * PAGE_SIZE + logs.length
      : page * PAGE_SIZE + 1)

  return (
    <Card className="p-0">
      <div className="p-5">
        <SectionTitle
          title={t('title')}
          subtitle={t('subtitle', { app })}
          right={
            <Button variant="ghost" onClick={() => refetch()}>
              {isFetching ? t('appDetail:state.updating') : t('common:actions.refresh')}
            </Button>
          }
        />

        {/* Filters */}
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Select
            value={level}
            onChange={(e) => setLevel(e.target.value as LogLevel | '')}
            className="w-auto"
          >
            <option value="">{t('allLevels')}</option>
            {LEVELS.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </Select>
          <div className="max-md:w-full">
            <TextInput
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder={t('filterSource')}
            />
          </div>
          <div className="max-md:w-full md:flex-1">
            <TextInput
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t('filterSearch')}
            />
          </div>
        </div>
      </div>

      {isLoading ? (
        <Loading label={t('loading')} />
      ) : isError ? (
        <div className="p-5">
          <ErrorBanner message={errMessage(error, t('loadError'))} />
        </div>
      ) : logs.length === 0 ? (
        <Empty label={t('empty')} />
      ) : (
        <div className="max-h-[65vh] divide-y divide-gray-200 overflow-auto font-mono text-xs dark:divide-gray-700">
          {logs.map((entry, i) => {
            const lvl = field(entry, 'level') || 'info'
            return (
              <div
                key={i}
                className="px-4 py-2 hover:bg-gray-100/50 md:flex md:gap-3 md:py-1.5 dark:hover:bg-gray-700/40"
              >
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
                <span className="mt-1 block break-all text-slate-600 md:mt-0 dark:text-slate-300">
                  {field(entry, 'message', 'msg')}
                </span>
              </div>
            )
          })}
        </div>
      )}

      {effectiveTotal > PAGE_SIZE && (
        <div className="flex justify-end border-t border-gray-200 p-4 dark:border-gray-700">
          <Pagination
            currentPage={page}
            pageSize={PAGE_SIZE}
            total={effectiveTotal}
            onChange={setPage}
          />
        </div>
      )}
    </Card>
  )
}
