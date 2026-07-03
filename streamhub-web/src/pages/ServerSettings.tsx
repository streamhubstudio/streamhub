/**
 * Server settings — READ-ONLY view of the core's effective configuration (#16).
 *
 * The panel SHOWS what is configured (secrets already redacted server-side:
 * `…Set` booleans, an `apiKeyMasked`, a `host:port` Redis endpoint) and gives
 * copy-paste GUIDANCE on how to change each group — it never writes anything and
 * there are no edit inputs. A banner warns when permission enforcement isn't
 * `on`. Global-scope (superadmin) surface: a 403 degrades to a friendly notice
 * instead of a crash.
 *
 * Data via @tanstack/react-query + the typed `api` client.
 */
import { useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { HiOutlineChevronDown } from 'react-icons/hi'
import { api, ApiRequestError, type ServerSettings, type SettingGuidance } from '@/api'
import { Alert, Button, Card, Skeleton, Tag } from '@/ui'
import { formatBytes } from '@/lib/bytes'
import { authzTone, enforcementActive, setTone, formatUptime, type Tone } from '@/lib/serverSettings'

const POLL_MS = 60_000
const EMPTY = '—'

// --- badges (Tag-based tone pills, matching the Cluster page) ----------------

const BADGE_TONE: Record<Tone | 'slate', string> = {
  green: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-100',
  amber: 'bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-100',
  red: 'bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-100',
  slate: 'bg-gray-100 text-gray-600 dark:bg-gray-600/60 dark:text-gray-100',
}

function ToneBadge({ tone, children }: { tone: keyof typeof BADGE_TONE; children: ReactNode }) {
  return <Tag className={`border-transparent py-0.5 ${BADGE_TONE[tone]}`}>{children}</Tag>
}

/** Green "configurado" / red "sin configurar" for a redacted secret's presence. */
function BoolBadge({ set }: { set: boolean }) {
  const { t } = useTranslation('serverSettings')
  return <ToneBadge tone={setTone(set)}>{t(set ? 'badge.configured' : 'badge.notConfigured')}</ToneBadge>
}

// --- copy helpers ------------------------------------------------------------

async function copyText(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text)
  } catch {
    /* clipboard unavailable */
  }
}

function CopyButton({ value }: { value: string }) {
  const { t } = useTranslation('common')
  const [copied, setCopied] = useState(false)
  return (
    <Button
      size="xs"
      variant="default"
      className="shrink-0"
      onClick={() => {
        void copyText(value)
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }}
    >
      {copied ? t('actions.copied') : t('actions.copy')}
    </Button>
  )
}

// --- key/value row -----------------------------------------------------------

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border/60 py-2 last:border-b-0">
      <span className="text-sm text-fg-muted">{label}</span>
      <span className="min-w-0 text-right text-sm font-medium text-fg">{children}</span>
    </div>
  )
}

/** A plain (mono) value with an em-dash fallback for empty strings. */
function Mono({ value }: { value: string | number | null | undefined }) {
  const s = value === null || value === undefined || value === '' ? EMPTY : String(value)
  return <span className="font-mono text-xs break-all">{s}</span>
}

// --- guidance ("Cómo cambiar") — collapsible per group -----------------------

function GuidanceBlock({ items }: { items: SettingGuidance[] | undefined }) {
  const { t } = useTranslation('serverSettings')
  const [open, setOpen] = useState(false)
  if (!items || items.length === 0) return null
  return (
    <div className="mt-4 border-t border-border/60 pt-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 text-left text-xs font-semibold uppercase tracking-wide text-fg-muted transition hover:text-fg"
      >
        <span>{t('guidance.title')}</span>
        <HiOutlineChevronDown className={`text-base transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <ul className="mt-3 space-y-3">
          {items.map((g) => (
            <li key={g.envVar} className="rounded-lg border border-border/60 bg-surface-raised/40 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-fg">{g.setting}</span>
                <code className="rounded bg-gray-200 px-1.5 py-0.5 font-mono text-[11px] dark:bg-gray-600/60">
                  {g.envVar}
                </code>
                <div className="ml-auto">
                  <CopyButton value={g.envVar} />
                </div>
              </div>
              <p className="mt-2 text-xs leading-relaxed text-fg-muted">{g.howToChange}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// --- section card ------------------------------------------------------------

function Section({
  title,
  subtitle,
  guidance,
  children,
}: {
  title: string
  subtitle?: string
  guidance?: SettingGuidance[]
  children: ReactNode
}) {
  return (
    <Card bordered>
      <div className="mb-2">
        <h2 className="text-sm font-semibold text-fg">{title}</h2>
        {subtitle && <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>}
      </div>
      <div>{children}</div>
      <GuidanceBlock items={guidance} />
    </Card>
  )
}

// --- page --------------------------------------------------------------------

export default function ServerSettings() {
  const { t } = useTranslation('serverSettings')

  const q = useQuery({
    queryKey: ['server-settings'],
    queryFn: ({ signal }) => api.system.settings(signal),
    refetchInterval: POLL_MS,
    retry: (count, err) => !(err instanceof ApiRequestError && err.status === 403) && count < 2,
  })

  const forbidden = q.error instanceof ApiRequestError && q.error.status === 403

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-fg">{t('title')}</h1>
        <p className="text-sm text-slate-400">{t('subtitle')}</p>
      </div>

      {forbidden ? (
        <Alert type="warning" showIcon>
          {t('forbidden')}
        </Alert>
      ) : q.isError ? (
        <Alert type="danger" showIcon>
          {t('loadError')}
        </Alert>
      ) : q.isLoading || !q.data ? (
        <LoadingState />
      ) : (
        <Loaded s={q.data} />
      )}
    </div>
  )
}

function LoadingState() {
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {[0, 1, 2, 3].map((i) => (
        <Card bordered key={i}>
          <Skeleton height={18} className="mb-4 w-32" />
          <Skeleton height={90} />
        </Card>
      ))}
    </div>
  )
}

function Loaded({ s }: { s: ServerSettings }) {
  const { t } = useTranslation('serverSettings')
  const enforced = enforcementActive(s.core.authzEnforce)

  return (
    <>
      {!enforced && (
        <Alert type="warning" showIcon>
          <span className="font-semibold">{t('authzBanner.title')}</span>{' '}
          {t('authzBanner.body', { mode: s.core.authzEnforce })}
        </Alert>
      )}

      <p className="text-xs text-fg-subtle">{t('readOnlyNote')}</p>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Core */}
        <Section title={t('sections.core')} guidance={s.guidance.core}>
          <Row label={t('core.nodeEnv')}><Mono value={s.core.nodeEnv} /></Row>
          <Row label={t('core.host')}><Mono value={s.core.host} /></Row>
          <Row label={t('core.port')}><Mono value={s.core.port} /></Row>
          <Row label={t('core.publicBaseUrl')}><Mono value={s.core.publicBaseUrl} /></Row>
          <Row label={t('core.publicWsUrl')}><Mono value={s.core.publicWsUrl} /></Row>
          <Row label={t('core.rtmpPublicHost')}><Mono value={s.core.rtmpPublicHost} /></Row>
          <Row label={t('core.logLevel')}><Mono value={s.core.logLevel} /></Row>
          <Row label={t('core.logRetentionDays')}><Mono value={s.core.logRetentionDays} /></Row>
          <Row label={t('core.authzEnforce')}>
            <ToneBadge tone={authzTone(s.core.authzEnforce)}>
              {t(`authz.${s.core.authzEnforce}`, { defaultValue: s.core.authzEnforce })}
            </ToneBadge>
          </Row>
          <Row label={t('core.redisUrl')}><Mono value={s.core.redisUrl} /></Row>
          <Row label={t('core.dataDir')}><Mono value={s.core.dataDir} /></Row>
        </Section>

        {/* Auth */}
        <Section title={t('sections.auth')} guidance={s.guidance.auth}>
          <Row label={t('auth.adminUser')}><Mono value={s.auth.adminUser} /></Row>
          <Row label={t('auth.jwtSecret')}><BoolBadge set={s.auth.jwtSecretSet} /></Row>
          <Row label={t('auth.adminPass')}><BoolBadge set={s.auth.adminPassSet} /></Row>
          <Row label={t('auth.smtp')}><BoolBadge set={s.auth.smtpConfigured} /></Row>
          <Row label={t('auth.superadminEmail')}><Mono value={s.auth.superadminEmail} /></Row>
        </Section>

        {/* LiveKit */}
        <Section title={t('sections.livekit')} guidance={s.guidance.livekit}>
          <Row label={t('livekit.url')}><Mono value={s.livekit.url} /></Row>
          <Row label={t('livekit.apiKey')}>
            <span className="flex items-center justify-end gap-2">
              {s.livekit.apiKeyMasked && <Mono value={s.livekit.apiKeyMasked} />}
              <BoolBadge set={s.livekit.apiKeySet} />
            </span>
          </Row>
        </Section>

        {/* Cluster */}
        <Section title={t('sections.cluster')} guidance={s.guidance.cluster}>
          <Row label={t('cluster.enabled')}>
            <ToneBadge tone={s.cluster.enabled ? 'green' : 'slate'}>
              {t(s.cluster.enabled ? 'badge.enabled' : 'badge.disabled')}
            </ToneBadge>
          </Row>
          <Row label={t('cluster.redis')}><BoolBadge set={s.cluster.redisConfigured} /></Row>
          <Row label={t('cluster.nodesCount')}><Mono value={s.cluster.nodesCount} /></Row>
        </Section>

        {/* Metrics */}
        <Section title={t('sections.metrics')} guidance={s.guidance.metrics}>
          <Row label={t('metrics.token')}><BoolBadge set={s.metrics.tokenSet} /></Row>
        </Section>

        {/* Storage */}
        <Section title={t('sections.storage')} guidance={s.guidance.storage}>
          <Row label={t('storage.dataDir')}><Mono value={s.storage.dataDir} /></Row>
          <Row label={t('storage.dbSize')}><Mono value={formatBytes(s.storage.dbSizeBytes)} /></Row>
          <Row label={t('storage.appsCount')}><Mono value={s.storage.appsCount} /></Row>
        </Section>

        {/* Runtime */}
        <Section title={t('sections.runtime')}>
          <Row label={t('runtime.uptime')}><Mono value={formatUptime(s.runtime.uptimeSeconds)} /></Row>
          <Row label={t('runtime.memoryRss')}><Mono value={formatBytes(s.runtime.memoryRssBytes)} /></Row>
          <Row label={t('runtime.pid')}><Mono value={s.runtime.pid} /></Row>
          <Row label={t('runtime.platform')}><Mono value={s.runtime.platform} /></Row>
          <Row label={t('runtime.coreVersion')}><Mono value={s.versions.core} /></Row>
          <Row label={t('runtime.nodeVersion')}><Mono value={s.versions.node} /></Row>
        </Section>

        {/* Ports */}
        <Section title={t('sections.ports')} subtitle={t('ports.subtitle')}>
          <Row label={t('ports.core')}><Mono value={s.ports.core} /></Row>
          <Row label={t('ports.livekitSignaling')}><Mono value={s.ports.livekitSignaling} /></Row>
          <Row label={t('ports.livekitTcp')}><Mono value={s.ports.livekitTcp} /></Row>
          <Row label={t('ports.livekitUdp')}><Mono value={s.ports.livekitUdp} /></Row>
          <Row label={t('ports.rtmp')}><Mono value={s.ports.rtmp} /></Row>
          <Row label={t('ports.whip')}><Mono value={s.ports.whip} /></Row>
        </Section>
      </div>
    </>
  )
}
