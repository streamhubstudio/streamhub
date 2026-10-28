/**
 * Security posture — superadmin-only compliance/evidence panel for auditors
 * (GET /system/compliance). Summary tiles (active / partial / off counts) over a
 * table mapping each ISO 27002 §8 technological control to its live state on
 * this deployment. A manual refresh re-gathers the evidence.
 *
 * Global-scope surface, gated like Server settings: 403 degrades to a friendly
 * notice, a core that predates the feature (404) shows an "upgrade required"
 * empty-state. Data via @tanstack/react-query + the typed `api` client; the
 * state → badge-tone mapping and summary fallback live in @/lib/audit
 * (unit-tested under node).
 */
import { type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { api, ApiRequestError, type ComplianceState } from '@/api'
import { Alert, Button, Card, Skeleton, Table, Tag } from '@/ui'
import { computeSummary, postureStateTone, type PostureTone } from '@/lib/audit'
import { formatDateTime } from '@/lib/datetime'

const { THead, TBody, Tr, Th, Td } = Table

const POLL_MS = 60_000

// --- badges ------------------------------------------------------------------

const BADGE_TONE: Record<PostureTone, string> = {
  green: 'bg-emerald-500/20 text-emerald-100',
  amber: 'bg-amber-500/20 text-amber-100',
  red: 'bg-red-500/20 text-red-100',
  slate: 'bg-gray-600/60 text-gray-100',
}

function ToneBadge({ tone, children }: { tone: PostureTone; children: ReactNode }) {
  return <Tag className={`border-transparent py-0.5 ${BADGE_TONE[tone]}`}>{children}</Tag>
}

const TILE_TONE: Record<PostureTone, string> = {
  green: 'border-emerald-500/30 text-emerald-300',
  amber: 'border-amber-500/30 text-amber-300',
  red: 'border-red-500/30 text-red-300',
  slate: 'border-border/60 text-fg-muted',
}

function SummaryTile({
  tone,
  count,
  label,
}: {
  tone: PostureTone
  count: number
  label: string
}) {
  return (
    <div className={`rounded-xl border bg-surface p-4 ${TILE_TONE[tone]}`}>
      <div className="text-3xl font-semibold tabular-nums">{count}</div>
      <div className="mt-1 text-xs font-medium uppercase tracking-wide text-fg-muted">{label}</div>
    </div>
  )
}

// --- page ---------------------------------------------------------------------

/** The four states as summary tiles, in severity order. */
const TILE_STATES: ComplianceState[] = ['active', 'partial', 'off', 'unknown']

export default function SecurityPosture() {
  const { t } = useTranslation(['compliance', 'common'])

  const { data, isLoading, isError, error, isFetching, refetch } = useQuery({
    queryKey: ['compliance'],
    queryFn: ({ signal }) => api.system.compliance(signal),
    refetchInterval: POLL_MS,
    retry: (count, err) =>
      !(err instanceof ApiRequestError && (err.status === 403 || err.status === 404)) &&
      count < 2,
  })

  const forbidden = error instanceof ApiRequestError && error.status === 403
  const unsupported = error instanceof ApiRequestError && error.status === 404

  // Prefer the backend rollup; fall back to counting the controls ourselves.
  const summary = data ? (data.summary ?? computeSummary(data.controls)) : null

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-fg">{t('compliance:title')}</h1>
          <p className="text-sm text-slate-400">{t('compliance:subtitle')}</p>
        </div>
        <Button size="sm" variant="default" onClick={() => refetch()}>
          {isFetching ? t('compliance:refreshing') : t('common:actions.refresh')}
        </Button>
      </div>

      <Alert type="info" showIcon>
        {t('compliance:explain')}
      </Alert>

      {forbidden ? (
        <Alert type="warning" showIcon>
          {t('compliance:forbidden')}
        </Alert>
      ) : unsupported ? (
        <Alert type="info" showIcon>
          {t('compliance:unsupported')}
        </Alert>
      ) : isError ? (
        <Alert type="danger" showIcon>
          {error instanceof ApiRequestError ? error.message : t('compliance:loadError')}
        </Alert>
      ) : isLoading || !data || !summary ? (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {TILE_STATES.map((s) => (
              <Skeleton key={s} height={92} />
            ))}
          </div>
          <Card bordered>
            <Skeleton height={220} />
          </Card>
        </>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {TILE_STATES.map((s) => (
              <SummaryTile
                key={s}
                tone={postureStateTone(s)}
                count={summary[s]}
                label={t(`compliance:state.${s}`)}
              />
            ))}
          </div>

          <Card bordered bodyClass="p-0" className="overflow-hidden">
            <div className="overflow-x-auto">
              <Table>
                <THead>
                  <Tr>
                    <Th>{t('compliance:col.control')}</Th>
                    <Th>{t('compliance:col.state')}</Th>
                    <Th>{t('compliance:col.iso')}</Th>
                    <Th>{t('compliance:col.detail')}</Th>
                  </Tr>
                </THead>
                <TBody>
                  {data.controls.map((c) => (
                    <Tr key={c.id}>
                      <Td>
                        <span className="text-sm font-medium text-fg">
                          {t(`compliance:control.${c.id}`, { defaultValue: c.name })}
                        </span>
                      </Td>
                      <Td>
                        <ToneBadge tone={postureStateTone(c.state)}>
                          {t(`compliance:state.${c.state}`, { defaultValue: c.state })}
                        </ToneBadge>
                      </Td>
                      <Td>
                        <span className="font-mono text-xs whitespace-nowrap text-fg-muted">
                          {t('compliance:isoPrefix')} {c.iso}
                        </span>
                      </Td>
                      <Td>
                        <span className="text-xs text-fg-muted">{c.detail}</span>
                      </Td>
                    </Tr>
                  ))}
                </TBody>
              </Table>
            </div>
          </Card>

          <p className="text-xs text-fg-subtle">
            {t('compliance:checkedAt', { at: formatDateTime(data.checkedAt) })}
          </p>
        </>
      )}
    </div>
  )
}
