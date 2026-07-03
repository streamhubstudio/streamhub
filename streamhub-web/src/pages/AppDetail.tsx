/**
 * AppDetail — management surface for a single app (tenant).
 *
 * Reads :app from the route, loads the app record (GET /apps/:name) for the
 * header, and renders a tabbed workspace. Each tab is a self-contained module
 * under ./AppDetail/ that owns its own queries/mutations via react-query.
 *
 * Pattern/aesthetic follows pages/Logs.tsx and the shared theme tokens.
 * Active tab is kept in the URL (?tab=) so it survives reloads / deep links.
 *
 * Installed plugins do NOT get their own tab anymore: their UIs open from the
 * Plugins tab via the "Open" action (see PluginsTab), keeping the tab bar to
 * the built-in surfaces. Old plugin deep links (?tab=<pluginId>) fall back to
 * the Plugins tab so nothing 404s.
 */
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '@/api'
import { Tabs, Tag } from '@/ui'
import { formatBytes } from '@/lib/bytes'
import { Loading, errMessage } from './AppDetail/ui'
import { OverviewTab } from './AppDetail/OverviewTab'
import { ConfigTab } from './AppDetail/ConfigTab'
import { StreamsTab } from './AppDetail/StreamsTab'
import { VodsTab } from './AppDetail/VodsTab'
import { IngressTab } from './AppDetail/IngressTab'
import { TokensTab } from './AppDetail/TokensTab'
import { IntegracionesTab } from './AppDetail/IntegracionesTab'
import { LogsTab } from './AppDetail/LogsTab'
import { SamplesTab } from './AppDetail/SamplesTab'
import { MaintenanceTab } from './AppDetail/MaintenanceTab'
import { PluginsTab } from './AppDetail/PluginsTab'

type TabId =
  | 'overview'
  | 'config'
  | 'streams'
  | 'vods'
  | 'ingress'
  | 'tokens'
  | 'integraciones'
  | 'logs'
  | 'samples'
  | 'plugins'
  | 'sistema'

/**
 * Tabs ordered by everyday flow. "Tablero" (overview) leads as the default
 * landing tab; the advanced "Config" tab is kept LAST:
 *  overview → live → recordings → ingest → tokens → samples → integrations →
 *  plugins → ops → config.
 * Labels/hints are resolved via i18n (appDetail:tabs.<id>).
 */
const TAB_IDS: TabId[] = [
  'overview',
  'streams',
  'vods',
  'ingress',
  'tokens',
  'samples',
  'integraciones',
  'plugins',
  'logs',
  'sistema',
  'config',
]

function isTabId(v: string | null): v is TabId {
  return TAB_IDS.some((id) => id === v)
}

export default function AppDetail() {
  const { t } = useTranslation('appDetail')
  const { app = '' } = useParams()
  const [searchParams, setSearchParams] = useSearchParams()

  const tabParam = searchParams.get('tab')
  // Built-in TabId, else default. A non-empty unknown value is almost always a
  // legacy plugin deep link (?tab=radio) → land on the Plugins tab.
  const active: TabId = isTabId(tabParam)
    ? tabParam
    : tabParam
      ? 'plugins'
      : 'overview'

  function selectTab(id: string) {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.set('tab', id)
        return next
      },
      { replace: true },
    )
  }

  const { data: appRecord, isLoading, isError, error } = useQuery({
    queryKey: ['app', app],
    queryFn: ({ signal }) => api.apps.get(app, signal),
    enabled: Boolean(app),
  })

  // Storage footprint for the header chips: this app's app.db size + the total
  // bytes of its recordings. Best-effort — a failure just hides the chips.
  const { data: sizes } = useQuery({
    queryKey: ['app-sizes', app],
    queryFn: ({ signal }) => api.apps.sizes(app, signal),
    enabled: Boolean(app),
  })

  // De-dup header: the h1 already shows the human name (falling back to the
  // slug). Only surface the slug as a faint identifier when a distinct display
  // name exists, and only show the room prefix when it isn't just the slug.
  const displayName = appRecord?.displayName?.trim()
  const showSlug = Boolean(displayName && displayName !== app)
  const roomPrefix = appRecord?.livekitRoomPrefix
  const showPrefix = Boolean(roomPrefix && roomPrefix !== app)

  return (
    <div>
      {/* Header */}
      <div className="mb-6">
        <Link to="/apps" className="text-xs text-fg-subtle transition hover:text-fg">
          {t('header.backToApps')}
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold text-fg">
              {appRecord?.displayName || app}
            </h1>
            {(showSlug || showPrefix) && (
              <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-fg-subtle">
                {showSlug && <span className="font-mono text-sky2">{app}</span>}
                {showPrefix && (
                  <span>
                    {t('header.prefix')}{' '}
                    <span className="font-mono">{roomPrefix}</span>
                  </span>
                )}
              </p>
            )}
          </div>
          {sizes && (
            <div className="flex flex-wrap items-center gap-2 max-md:w-full">
              <Tag className="gap-1.5 border-transparent bg-gray-100 text-gray-600 dark:bg-gray-600/60 dark:text-gray-100">
                <span
                  title={t('sizes.dbTitle')}
                  className="uppercase tracking-wider text-gray-500 dark:text-gray-400"
                >
                  {t('sizes.db')}
                </span>
                <span className="font-mono tabular-nums">
                  {formatBytes(sizes.dbSizeBytes)}
                </span>
              </Tag>
              <Tag className="gap-1.5 border-transparent bg-gray-100 text-gray-600 dark:bg-gray-600/60 dark:text-gray-100">
                <span
                  title={t('sizes.vodsTitle')}
                  className="uppercase tracking-wider text-gray-500 dark:text-gray-400"
                >
                  {t('sizes.vods')}
                </span>
                <span className="font-mono tabular-nums">
                  {formatBytes(sizes.vodTotalBytes)}
                </span>
              </Tag>
            </div>
          )}
          <div className="ml-auto flex flex-wrap items-center gap-2 max-md:ml-0 max-md:w-full">
            {/* Broadcast (Transmitir) lives INSIDE the app — it was removed
                from the global sidebar. This quick launcher opens the
                full-screen Studio for this app. */}
            <Link
              to={`/broadcast/${encodeURIComponent(app)}`}
              className="btn-accent inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-semibold transition"
            >
              <svg
                className="h-3.5 w-3.5"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.8}
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M15 10l4.5-2.5v9L15 14M3 7h12v10H3z"
                />
              </svg>
              {t('header.broadcastCamera')}
            </Link>
          </div>
        </div>
        {isError && (
          <p className="mt-1 text-xs text-danger">
            {errMessage(error, t('header.loadError'))}
          </p>
        )}
      </div>

      {/* Tab bar — Elstar underline tabs. The `.tab-list` already scrolls
          horizontally on mobile, so the tabs never wrap. Controlled by the
          URL-backed `active` value; content is rendered separately below.
          Plugin UIs open from the Plugins tab (no per-plugin tabs). */}
      <Tabs
        value={active}
        onChange={selectTab}
        variant="underline"
        className="mb-2 text-sm"
      >
        <Tabs.TabList>
          {TAB_IDS.map((id) => (
            <Tabs.TabNav key={id} value={id}>
              <span title={t(`tabs.${id}.hint`)}>{t(`tabs.${id}.label`)}</span>
            </Tabs.TabNav>
          ))}
        </Tabs.TabList>
      </Tabs>

      {/* Active-tab caption */}
      <p className="mb-5 text-xs text-fg-subtle">{t(`tabs.${active}.hint`)}</p>

      {/* Tab content */}
      {isLoading ? (
        <Loading label={t('loadingApp')} />
      ) : (
        <div>
          {active === 'overview' && <OverviewTab app={app} />}
          {active === 'config' && <ConfigTab app={app} />}
          {active === 'streams' && <StreamsTab app={app} />}
          {active === 'vods' && <VodsTab app={app} />}
          {active === 'ingress' && <IngressTab app={app} />}
          {active === 'tokens' && <TokensTab app={app} />}
          {active === 'integraciones' && <IntegracionesTab app={app} />}
          {active === 'plugins' && <PluginsTab app={app} />}
          {active === 'logs' && <LogsTab app={app} />}
          {active === 'samples' && <SamplesTab app={app} />}
          {active === 'sistema' && <MaintenanceTab app={app} />}
        </div>
      )}
    </div>
  )
}
