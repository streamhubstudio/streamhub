/**
 * Tablero (overview) — the app's at-a-glance dashboard and the default tab.
 *
 * Polls GET /apps/:app/stats every 10s (react-query refetchInterval) and, while
 * the page stays open, accumulates the viewers/streams samples in memory to feed
 * two hand-rolled SVG sparklines (last 30 points). Below the cards: the
 * "Pipeline" card (GET /apps/:app/pipeline → the animated <AppFlowDiagram> of
 * how this app is configured), the live rooms table (with a jump to the public
 * player) and a compact recent-events feed backed by GET /apps/:app/logs
 * (limit 15) with a level + quick-range filter and a "see all" jump to the
 * Logs tab.
 *
 * Degrades gracefully: if the stats endpoint isn't live yet the cards render
 * placeholders (—) instead of throwing.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '@/api'
import type { AppLiveRoom, LogEntry, LogLevel } from '@/api'
import { formatBytes } from '@/lib/bytes'
import { formatDateTime as fmtTime } from '@/lib/datetime'
import { pushCapped } from '@/lib/sparkline'
import { reduceVodStatus } from '@/lib/appStats'
import {
  clampPage,
  nextSort,
  pageSlice,
  roomStatus,
  sortRooms,
  type RoomSort,
  type RoomSortKey,
} from '@/lib/liveRooms'
import { Sparkline } from '@/components/Sparkline'
import { AppFlowDiagram } from '@/components/AppFlowDiagram'
import { SetupWizardBanner } from '@/components/onboarding/SetupWizardBanner'
import { Card as UICard, Pagination } from '@/ui'
import { useAppTimezone } from '@/lib/appTimezone'
import {
  Badge,
  Empty,
  ErrorBanner,
  Loading,
  RTable,
  RTd,
  RTh,
  RTr,
  SectionTitle,
  Select,
  errMessage,
} from './ui'

const POLL_MS = 10_000
const MAX_POINTS = 30
const FEED_LIMIT = 15

// --- small helpers ----------------------------------------------------------

function levelTone(level: string): 'red' | 'amber' | 'cyan' | 'slate' {
  const l = level.toLowerCase()
  if (l === 'error' || l === 'fatal') return 'red'
  if (l === 'warn') return 'amber'
  if (l === 'info') return 'cyan'
  return 'slate'
}

function field(entry: LogEntry, ...keys: (keyof LogEntry)[]): string {
  for (const k of keys) {
    const v = entry[k]
    if (v !== undefined && v !== null && v !== '') return String(v)
  }
  return ''
}

// --- metric card (Dashboard/StatsGrid aesthetic) ----------------------------

function MetricCard({
  label,
  value,
  hint,
  children,
}: {
  label: string
  value: ReactNode
  hint?: ReactNode
  children?: ReactNode
}) {
  return (
    <UICard bordered bodyClass="px-5 py-4">
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-2 flex items-baseline gap-2">
        <span className="text-2xl font-semibold tabular-nums text-fg">{value}</span>
        {hint && <span className="text-xs text-slate-500">{hint}</span>}
      </div>
      {children && <div className="mt-3">{children}</div>}
    </UICard>
  )
}

// --- pipeline flow card -------------------------------------------------------

/**
 * "Pipeline" — the animated flow diagram of how this app is configured
 * (GET /apps/:app/pipeline → <AppFlowDiagram>). Same 10s poll as the stats so
 * the live/active accents track reality. Degrades gracefully: while the
 * endpoint isn't live yet (404) the card shows a quiet placeholder.
 */
function PipelineCard({ app }: { app: string }) {
  const { t } = useTranslation('appFlow')

  const { data, isLoading, isError } = useQuery({
    queryKey: ['app-pipeline', app],
    queryFn: ({ signal }) => api.apps.pipeline(app, signal),
    refetchInterval: POLL_MS,
    placeholderData: keepPreviousData,
  })

  return (
    <UICard bordered bodyClass="p-5">
      <SectionTitle title={t('title')} subtitle={t('subtitle')} />
      {isLoading ? (
        <Loading label={t('loading')} />
      ) : isError || !data ? (
        <Empty label={t('unavailable')} />
      ) : (
        <AppFlowDiagram pipeline={data} />
      )}
    </UICard>
  )
}

// --- recent events feed -----------------------------------------------------

type QuickRange = 'today' | '24h' | '7d'

function rangeSince(range: QuickRange, now = Date.now()): string {
  if (range === 'today') {
    const d = new Date(now)
    d.setHours(0, 0, 0, 0)
    return d.toISOString()
  }
  const ms = range === '7d' ? 7 * 86_400_000 : 24 * 86_400_000
  return new Date(now - ms).toISOString()
}

const FEED_LEVELS: LogLevel[] = ['info', 'warn', 'error']
const FEED_RANGES: QuickRange[] = ['today', '24h', '7d']

function EventsFeed({ app }: { app: string }) {
  const { t } = useTranslation(['overviewTab', 'common'])
  const tz = useAppTimezone()
  const [level, setLevel] = useState<LogLevel | ''>('')
  const [range, setRange] = useState<QuickRange>('24h')
  // Rows the operator expanded to read the full (otherwise truncated) message.
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const toggleRow = (i: number) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })

  const params = useMemo(
    () => ({ level: level || undefined, since: rangeSince(range), limit: FEED_LIMIT }),
    [level, range],
  )

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['app-overview-logs', app, params],
    queryFn: ({ signal }) => api.logs.queryApp(app, params, signal),
    refetchInterval: POLL_MS,
    placeholderData: keepPreviousData,
  })

  const items = data?.items ?? []

  return (
    <UICard bordered bodyClass="p-0">
      <div className="p-5">
        <SectionTitle
          title={t('events.title')}
          subtitle={t('events.subtitle')}
          right={
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={level}
                onChange={(e) => setLevel(e.target.value as LogLevel | '')}
                className="w-auto"
              >
                <option value="">{t('events.allLevels')}</option>
                {FEED_LEVELS.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </Select>
              <Select
                value={range}
                onChange={(e) => setRange(e.target.value as QuickRange)}
                className="w-auto"
              >
                {FEED_RANGES.map((r) => (
                  <option key={r} value={r}>
                    {t(`events.range.${r}`)}
                  </option>
                ))}
              </Select>
              <Link
                to="?tab=config&section=system&sub=logs"
                className="text-xs font-medium text-primary-500 transition hover:text-fg"
              >
                {t('events.seeAll')} →
              </Link>
            </div>
          }
        />
      </div>
      {isLoading ? (
        <Loading label={t('events.loading')} />
      ) : isError ? (
        <div className="p-5">
          <ErrorBanner message={errMessage(error, t('events.loadError'))} />
        </div>
      ) : items.length === 0 ? (
        <Empty label={t('events.empty')} />
      ) : (
        <div className="max-h-[42vh] divide-y divide-gray-200 overflow-auto font-mono text-xs dark:divide-gray-700">
          {items.map((entry, i) => {
            const lvl = field(entry, 'level') || 'info'
            const message = field(entry, 'message', 'msg')
            const isOpen = expanded.has(i)
            return (
              <button
                key={i}
                type="button"
                onClick={() => toggleRow(i)}
                aria-expanded={isOpen}
                aria-label={t('events.toggleRow')}
                className="flex w-full items-start gap-3 px-4 py-2 text-left hover:bg-gray-100/50 dark:hover:bg-gray-700/40"
              >
                <span className="w-40 shrink-0 text-slate-500">
                  {fmtTime(field(entry, 'ts', 'time') || undefined, tz)}
                </span>
                <Badge tone={levelTone(lvl)}>{lvl.toUpperCase()}</Badge>
                <span className="w-24 shrink-0 truncate text-slate-500">
                  {field(entry, 'source')}
                </span>
                <span
                  title={message}
                  className={`min-w-0 flex-1 text-slate-600 dark:text-slate-300 ${
                    isOpen ? 'whitespace-pre-wrap break-words' : 'truncate'
                  }`}
                >
                  {message}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </UICard>
  )
}

// --- live rooms table -------------------------------------------------------

const ROOMS_PAGE_SIZE = 20

/** A column header that toggles the table sort when clicked. */
function SortTh({
  label,
  sortKey,
  sort,
  onSort,
  className = '',
}: {
  label: string
  sortKey: RoomSortKey
  sort: RoomSort
  onSort: (key: RoomSortKey) => void
  className?: string
}) {
  const { t } = useTranslation('overviewTab')
  const active = sort.key === sortKey
  return (
    <RTh className={className}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        aria-label={t('rooms.sortBy', { col: label })}
        aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
        className={`inline-flex items-center gap-1 font-semibold uppercase tracking-wider transition hover:text-fg ${
          active ? 'text-fg' : ''
        }`}
      >
        {label}
        <span aria-hidden className="text-[9px] leading-none">
          {active ? (sort.dir === 'asc' ? '▲' : '▼') : '↕'}
        </span>
      </button>
    </RTh>
  )
}

function LiveRooms({ app, rooms }: { app: string; rooms: AppLiveRoom[] }) {
  const { t } = useTranslation('overviewTab')
  const tz = useAppTimezone()
  const [sort, setSort] = useState<RoomSort>({ key: 'since', dir: 'desc' })
  const [page, setPage] = useState(1)

  const sorted = useMemo(() => sortRooms(rooms, sort), [rooms, sort])
  // Keep the current page valid as the polled list grows/shrinks.
  const safePage = clampPage(page, sorted.length, ROOMS_PAGE_SIZE)
  const pageRows = pageSlice(sorted, safePage, ROOMS_PAGE_SIZE)

  function onSort(key: RoomSortKey) {
    setSort((prev) => nextSort(prev, key))
    setPage(1)
  }

  return (
    <UICard bordered bodyClass="p-0">
      <div className="p-5">
        <SectionTitle title={t('rooms.title')} subtitle={t('rooms.subtitle')} />
      </div>
      {rooms.length === 0 ? (
        <Empty label={t('rooms.empty')} />
      ) : (
        <>
          <RTable
            head={
              <tr>
                <SortTh label={t('rooms.room')} sortKey="room" sort={sort} onSort={onSort} />
                <SortTh label={t('rooms.viewers')} sortKey="viewers" sort={sort} onSort={onSort} />
                <SortTh
                  label={t('rooms.publishers')}
                  sortKey="publishers"
                  sort={sort}
                  onSort={onSort}
                />
                <SortTh label={t('rooms.since')} sortKey="since" sort={sort} onSort={onSort} />
                <SortTh label={t('rooms.status')} sortKey="status" sort={sort} onSort={onSort} />
                <RTh className="text-right">{t('rooms.actions')}</RTh>
              </tr>
            }
          >
            {pageRows.map((r) => {
              const status = roomStatus(r)
              return (
                <RTr key={r.room}>
                  <RTd label={t('rooms.room')} className="font-mono text-xs text-fg">
                    {r.room}
                  </RTd>
                  <RTd
                    label={t('rooms.viewers')}
                    className="tabular-nums text-slate-600 dark:text-slate-300"
                  >
                    {r.viewers ?? '—'}
                  </RTd>
                  <RTd
                    label={t('rooms.publishers')}
                    className="tabular-nums text-slate-600 dark:text-slate-300"
                  >
                    {r.publishers}
                  </RTd>
                  <RTd label={t('rooms.since')} className="text-xs text-slate-500">
                    {fmtTime(r.startedAt, tz)}
                  </RTd>
                  <RTd label={t('rooms.status')}>
                    <Badge tone={status === 'live' ? 'green' : 'slate'}>
                      {status === 'live' ? t('rooms.statusLive') : t('rooms.statusOffline')}
                    </Badge>
                  </RTd>
                  <RTd actions className="text-right">
                    <Link
                      to={`/play/${encodeURIComponent(app)}/${encodeURIComponent(r.room)}`}
                      className="text-xs font-medium text-primary-500 transition hover:text-fg"
                    >
                      {t('rooms.watch')} →
                    </Link>
                  </RTd>
                </RTr>
              )
            })}
          </RTable>
          {sorted.length > ROOMS_PAGE_SIZE && (
            <div className="flex justify-end border-t border-gray-200 p-4 dark:border-gray-700">
              <Pagination
                currentPage={safePage}
                pageSize={ROOMS_PAGE_SIZE}
                total={sorted.length}
                onChange={setPage}
              />
            </div>
          )}
        </>
      )}
    </UICard>
  )
}

// --- tab shell --------------------------------------------------------------

export function OverviewTab({ app }: { app: string }) {
  const { t } = useTranslation(['overviewTab', 'common'])

  const { data: stats, isLoading, isError, error } = useQuery({
    queryKey: ['app-stats', app],
    queryFn: ({ signal }) => api.apps.stats(app, signal),
    refetchInterval: POLL_MS,
    placeholderData: keepPreviousData,
  })

  // Accumulate sparkline samples in memory while the page stays open.
  const [viewerPoints, setViewerPoints] = useState<number[]>([])
  const [streamPoints, setStreamPoints] = useState<number[]>([])
  const lastTs = useRef<string | null>(null)

  useEffect(() => {
    const ts = stats?.ts
    if (!ts || ts === lastTs.current) return
    lastTs.current = ts
    setViewerPoints((p) => pushCapped(p, stats.live?.totalViewers ?? 0, MAX_POINTS))
    setStreamPoints((p) => pushCapped(p, stats.live?.activeStreams ?? 0, MAX_POINTS))
  }, [stats])

  if (isLoading && !stats) {
    return <Loading label={t('loading')} />
  }

  const live = stats?.live
  const vods = stats?.vods
  const vodStatus = reduceVodStatus(vods?.byStatus)
  const storageTotal =
    stats?.storage != null
      ? (stats.storage.appDbBytes ?? 0) + (stats.storage.vodBytes ?? 0)
      : undefined
  const events = stats?.events24h
  const viewersNull = live?.totalViewers == null
  const rooms = live?.rooms ?? []

  return (
    <div className="space-y-5">
      {isError && !stats && (
        <ErrorBanner message={errMessage(error, t('loadError'))} />
      )}

      {/* Setup wizard re-entry — only while onboarding is unresolved. */}
      <SetupWizardBanner app={app} />

      {/* Metric cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <MetricCard
          label={t('cards.viewers')}
          value={viewersNull ? '—' : (live?.totalViewers ?? 0)}
          hint={viewersNull ? t('cards.viewersHint') : undefined}
        >
          <Sparkline values={viewerPoints} ariaLabel={t('cards.viewers')} />
        </MetricCard>

        <MetricCard label={t('cards.streams')} value={live?.activeStreams ?? 0}>
          <Sparkline
            values={streamPoints}
            className="text-emerald-500"
            ariaLabel={t('cards.streams')}
          />
        </MetricCard>

        <MetricCard
          label={t('cards.vods')}
          value={vods?.count ?? 0}
          hint={formatBytes(vods?.totalBytes)}
        >
          <div className="flex flex-wrap gap-1.5">
            {vodStatus.ready > 0 && (
              <Badge tone="green">{t('cards.vodReady', { n: vodStatus.ready })}</Badge>
            )}
            {vodStatus.pending > 0 && (
              <Badge tone="cyan">{t('cards.vodPending', { n: vodStatus.pending })}</Badge>
            )}
            {vodStatus.failed > 0 && (
              <Badge tone="red">{t('cards.vodFailed', { n: vodStatus.failed })}</Badge>
            )}
          </div>
        </MetricCard>

        <MetricCard
          label={t('cards.storage')}
          value={formatBytes(storageTotal)}
          hint={
            stats?.storage
              ? t('cards.storageHint', {
                  db: formatBytes(stats.storage.appDbBytes),
                  vods: formatBytes(stats.storage.vodBytes),
                })
              : undefined
          }
        />

        <MetricCard
          label={t('cards.ingress')}
          value={`${stats?.ingress?.active ?? 0} / ${stats?.ingress?.total ?? 0}`}
          hint={t('cards.ingressHint')}
        />

        <MetricCard label={t('cards.events')} value={events?.info ?? 0}>
          <div className="flex flex-wrap gap-1.5">
            <Badge tone={events?.error ? 'red' : 'slate'}>
              {t('cards.eventsError', { n: events?.error ?? 0 })}
            </Badge>
            <Badge tone={events?.warn ? 'amber' : 'slate'}>
              {t('cards.eventsWarn', { n: events?.warn ?? 0 })}
            </Badge>
          </div>
        </MetricCard>
      </div>

      {/* How this app is configured — the animated pipeline flow */}
      <PipelineCard app={app} />

      {/* Live rooms */}
      <LiveRooms app={app} rooms={rooms} />

      {/* Recent events */}
      <EventsFeed app={app} />
    </div>
  )
}
