/**
 * OS performance tuning — read-only panel embedded in Server settings, next to
 * the security-posture pattern. A table of the kernel/limit knobs that matter
 * for a LiveKit/WebRTC media server (UDP socket buffers, listen backlog,
 * udp_mem, ephemeral port range, file-descriptor limits, swappiness,
 * transparent hugepages): knob → current → recommended → status badge
 * (applied ✓ / not applied ⚠ / n/a), plus a copy-paste "how to apply" sysctl
 * line per row. The core only READS /proc — install.sh applies these on a real
 * host; a non-Linux node degrades to all-n/a.
 *
 * Superadmin-gated like the rest of Settings: a 403 (or a core that predates
 * the endpoint, 404) renders nothing rather than a broken card. The
 * status → badge-tone mapping + summary fallback live in @/lib/osTuning
 * (unit-tested under node).
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { api, ApiRequestError, type OsTuningKnob, type OsTuningReport } from '@/api'
import { Alert, Button, Card, Skeleton, Table, Tag } from '@/ui'
import { formatDateTime } from '@/lib/datetime'
import { computeTuningSummary, tuningStatusTone, type TuningTone } from '@/lib/osTuning'

const { THead, TBody, Tr, Th, Td } = Table

const POLL_MS = 60_000

// --- badges + tiles ----------------------------------------------------------

const BADGE_TONE: Record<TuningTone, string> = {
  green: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-100',
  amber: 'bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-100',
  slate: 'bg-gray-100 text-gray-600 dark:bg-gray-600/60 dark:text-gray-100',
}

const STATUS_ICON: Record<OsTuningKnob['status'], string> = {
  applied: '✓',
  'not-applied': '⚠',
  unknown: '',
}

function StatusBadge({ status }: { status: OsTuningKnob['status'] }) {
  const { t } = useTranslation('osTuning')
  const tone = tuningStatusTone(status)
  const icon = STATUS_ICON[status]
  return (
    <Tag className={`border-transparent py-0.5 whitespace-nowrap ${BADGE_TONE[tone]}`}>
      {icon ? `${icon} ` : ''}
      {t(`status.${status}`, { defaultValue: status })}
    </Tag>
  )
}

const TILE_TONE: Record<TuningTone, string> = {
  green: 'border-emerald-500/30 text-emerald-600 dark:text-emerald-300',
  amber: 'border-amber-500/30 text-amber-600 dark:text-amber-300',
  slate: 'border-border/60 text-fg-muted',
}

function SummaryTile({ tone, count, label }: { tone: TuningTone; count: number; label: string }) {
  return (
    <div className={`rounded-xl border bg-surface p-4 ${TILE_TONE[tone]}`}>
      <div className="text-3xl font-semibold tabular-nums">{count}</div>
      <div className="mt-1 text-xs font-medium uppercase tracking-wide text-fg-muted">{label}</div>
    </div>
  )
}

// --- copy button (mirrors ServerSettings) ------------------------------------

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

// --- section -----------------------------------------------------------------

export function OsTuningSection() {
  const { t } = useTranslation('osTuning')

  const q = useQuery({
    queryKey: ['os-tuning'],
    queryFn: ({ signal }) => api.system.osTuning(signal),
    refetchInterval: POLL_MS,
    retry: (count, err) =>
      !(err instanceof ApiRequestError && (err.status === 403 || err.status === 404)) && count < 2,
  })

  // Superadmin-gated like the rest of Settings: a 403 (or an older core without
  // the endpoint, 404) renders nothing rather than a broken card.
  if (q.error instanceof ApiRequestError && (q.error.status === 403 || q.error.status === 404)) {
    return null
  }

  return (
    <Card bordered>
      <div className="mb-3">
        <h2 className="text-sm font-semibold text-fg">{t('title')}</h2>
        <p className="mt-0.5 text-xs text-slate-500">{t('subtitle')}</p>
      </div>

      <Alert type="info" showIcon>
        {t('explain')}
      </Alert>

      {q.isError ? (
        <Alert type="danger" showIcon>
          {q.error instanceof ApiRequestError ? q.error.message : t('loadError')}
        </Alert>
      ) : q.isLoading || !q.data ? (
        <div className="mt-4">
          <Skeleton height={220} />
        </div>
      ) : (
        <Loaded report={q.data} />
      )}
    </Card>
  )
}

function Loaded({ report }: { report: OsTuningReport }) {
  const { t } = useTranslation('osTuning')
  const summary = report.summary ?? computeTuningSummary(report.knobs)
  const EMPTY = t('empty')

  return (
    <div className="mt-4 space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <SummaryTile tone="green" count={summary.applied} label={t('summary.applied')} />
        <SummaryTile tone="amber" count={summary.notApplied} label={t('summary.notApplied')} />
        <SummaryTile tone="slate" count={summary.unknown} label={t('summary.unknown')} />
      </div>

      {!report.supported && (
        <Alert type="warning" showIcon>
          {t('unsupportedPlatform', { platform: report.platform })}
        </Alert>
      )}

      <div className="overflow-x-auto">
        <Table>
          <THead>
            <Tr>
              <Th>{t('col.knob')}</Th>
              <Th>{t('col.current')}</Th>
              <Th>{t('col.recommended')}</Th>
              <Th>{t('col.status')}</Th>
              <Th>{t('col.howToApply')}</Th>
            </Tr>
          </THead>
          <TBody>
            {report.knobs.map((k) => (
              <Tr key={k.id}>
                <Td>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-fg">{k.label}</span>
                    {k.optional && (
                      <Tag className="border-transparent bg-gray-100 py-0 text-[10px] text-gray-500 dark:bg-gray-600/60 dark:text-gray-300">
                        {t('optionalTag')}
                      </Tag>
                    )}
                  </div>
                  <code className="mt-0.5 block font-mono text-[11px] break-all text-fg-muted">{k.key}</code>
                  <p className="mt-1 max-w-prose text-xs leading-relaxed text-fg-subtle">{k.why}</p>
                </Td>
                <Td>
                  <span className="font-mono text-xs break-all">{k.current ?? EMPTY}</span>
                </Td>
                <Td>
                  <span className="text-xs text-fg-muted">{k.recommended}</span>
                </Td>
                <Td>
                  <StatusBadge status={k.status} />
                </Td>
                <Td>
                  <div className="flex items-start gap-2">
                    <code className="min-w-0 rounded bg-gray-200 px-1.5 py-0.5 font-mono text-[11px] break-all dark:bg-gray-600/60">
                      {k.remedy}
                    </code>
                    <CopyButton value={k.remedy} />
                  </div>
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      </div>

      <p className="text-xs text-fg-subtle">{report.note}</p>
      <p className="text-xs text-fg-subtle">
        {t('checkedAt', { at: formatDateTime(report.checkedAt) })}
      </p>
    </div>
  )
}
